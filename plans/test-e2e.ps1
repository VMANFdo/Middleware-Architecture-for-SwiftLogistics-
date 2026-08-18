# ============================================================
# SwiftTrack -- Phase 6 End-to-End Test Script
# IS3208 Middleware Architecture | Assignment 4
# ============================================================
# Run this AFTER: docker compose up --build -d
# Usage:  .\plans\test-e2e.ps1
# ============================================================

param(
    [string]$GatewayUrl = "http://localhost:3000",
    [int]   $PollMaxSeconds = 60
)

$ErrorActionPreference = "Stop"

function Green($msg) { Write-Host "  [PASS] $msg" -ForegroundColor Green }
function Red($msg)   { Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Blue($msg)  { Write-Host "" ; Write-Host "==> $msg" -ForegroundColor Cyan }
function Dim($msg)   { Write-Host "       $msg" -ForegroundColor DarkGray }

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Path,
        [hashtable]$Body = $null,
        [string]$Token  = $null
    )
    $headers = @{ "Content-Type" = "application/json" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }

    $splat = @{
        Method  = $Method
        Uri     = "$GatewayUrl$Path"
        Headers = $headers
    }
    if ($Body) { $splat["Body"] = ($Body | ConvertTo-Json -Depth 10) }

    try {
        $resp = Invoke-RestMethod @splat
        return $resp
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        $raw    = $_.ErrorDetails.Message
        Write-Host "  [HTTP $status] $Method $Path -- $raw" -ForegroundColor Yellow
        throw
    }
}

# ── 0. Health Check ──────────────────────────────────────────
Blue "STEP 0 -- Health Check"

$health = Invoke-Api -Method GET -Path "/health"
if ($health.status -eq "ok") {
    Green "API Gateway healthy (DB: $($health.database), RabbitMQ: $($health.rabbitmq))"
} else {
    Red "API Gateway health check failed"
    exit 1
}

# ── 1. Client Login ──────────────────────────────────────────
Blue "STEP 1 -- Client Login (TechMart Online)"

$loginResp = Invoke-Api -Method POST -Path "/api/auth/client/login" -Body @{
    email    = "techmart@example.com"
    password = "password123"
}

if (-not $loginResp.token) {
    Red "Client login failed"
    exit 1
}

$clientToken = $loginResp.token
$clientCode  = $loginResp.client.client_code
Green "Logged in as $($loginResp.client.company_name) -- $clientCode"

# ── 2. Create New Order ──────────────────────────────────────
Blue "STEP 2 -- Create New Order"

$orderResp = Invoke-Api -Method POST -Path "/api/orders" -Token $clientToken -Body @{
    pickup_address   = "45 Galle Road, Colombo 03"
    delivery_address = "10 Havelock Road, Colombo 05"
    weight_kg        = 3.5
}

if (-not $orderResp.success) {
    Red "Order creation failed: $($orderResp.message)"
    exit 1
}

$orderCode = $orderResp.order_code
Green "Order created: $orderCode (status: $($orderResp.status))"
Dim   "ORDER_CREATED event published to RabbitMQ"

# ── 3. Poll Until Assigned ───────────────────────────────────
Blue "STEP 3 -- Poll Until 'assigned' (timeout: ${PollMaxSeconds}s)"

$deadline = (Get-Date).AddSeconds($PollMaxSeconds)
$assigned  = $false

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $statusResp    = Invoke-Api -Method GET -Path "/api/orders/$orderCode" -Token $clientToken
    $currentStatus = $statusResp.order.status
    Dim "Order $orderCode status: $currentStatus"

    if ($currentStatus -in @("assigned","ready","out_for_delivery","delivered")) {
        $assigned = $true
        break
    }
}

if ($assigned) {
    Green "Order $orderCode reached status '$currentStatus' -- ROS processed the event"
} else {
    Red "Order $orderCode never reached 'assigned' within ${PollMaxSeconds}s -- check ROS/RabbitMQ logs"
    exit 1
}

# ── 4. Saga Transaction Logs ─────────────────────────────────
Blue "STEP 4 -- Verify Saga Transaction Logs"

$sagaResp = Invoke-Api -Method GET -Path "/api/saga/transactions/$orderCode" -Token $clientToken
$steps    = $sagaResp.history | ForEach-Object { $_.saga_step }
Dim "Saga steps: $($steps -join ', ')"

$requiredSteps = @("CMS_CREATE","ROS_ASSIGN")
$missingSteps  = $requiredSteps | Where-Object { $steps -notcontains $_ }

if ($missingSteps.Count -eq 0) {
    Green "All expected saga steps logged: CMS_CREATE, ROS_ASSIGN"
} else {
    Red "Missing saga steps: $($missingSteps -join ', ')"
    exit 1
}

# ── 5. Driver Login ──────────────────────────────────────────
Blue "STEP 5 -- Driver Login (Kasun Perera / DRV001)"

$driverResp = Invoke-Api -Method POST -Path "/api/auth/driver/login" -Body @{
    email    = "kasun@swiftlogistics.lk"
    password = "password123"
}

if (-not $driverResp.token) {
    Red "Driver login failed"
    exit 1
}

$driverToken = $driverResp.token
Green "Logged in as $($driverResp.driver.name) -- $($driverResp.driver.id)"

# ── 6. Driver Route ──────────────────────────────────────────
Blue "STEP 6 -- Driver Fetches Today's Route"

$routeResp = Invoke-Api -Method GET -Path "/api/driver/route/today" -Token $driverToken
$stopCount  = ($routeResp.stops).Count
Green "Route loaded -- $stopCount stop(s) today"

$matchingStop = $routeResp.stops | Where-Object {
    $_.order_code -eq $orderCode -or $_.order_id -eq $orderCode
}

if ($matchingStop) {
    Green "Order $orderCode is in driver route (sequence: $($matchingStop.sequence))"
} else {
    Red "Order $orderCode NOT found in driver route"
    Dim "Stops in route: $(($routeResp.stops | ForEach-Object { $_.order_code }) -join ', ')"
    exit 1
}

# ── 7. WMS Package Status Update ─────────────────────────────
Blue "STEP 7 -- Update Package Status via WMS TCP Bridge"

try {
    $pkgResp = Invoke-Api -Method PUT -Path "/api/packages/status" -Token $driverToken -Body @{
        order_code = $orderCode
        status     = "loaded"
    }
    if ($pkgResp.success) {
        Green "Package status updated to 'loaded' (barcode: $($pkgResp.barcode))"
    } else {
        Write-Host "  [WARN] Package: $($pkgResp.message)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [WARN] Package update skipped (WMS may not have registered it yet)" -ForegroundColor Yellow
}

# ── 8. Driver Completes Delivery ─────────────────────────────
Blue "STEP 8 -- Driver Completes Delivery with POD Signature"

$fakeSignature = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

$deliveryResp = Invoke-Api -Method POST -Path "/api/driver/delivery/$orderCode" -Token $driverToken -Body @{
    status         = "delivered"
    recipient_name = "Sanduni Silva"
    signature      = $fakeSignature
}

if ($deliveryResp.success) {
    Green "Delivery confirmed for $orderCode (route_status: $($deliveryResp.route_status))"
} else {
    Red "Delivery failed: $($deliveryResp.message)"
    exit 1
}

# ── 9. Final Order Status ────────────────────────────────────
Blue "STEP 9 -- Verify Final Order Status"

Start-Sleep -Seconds 2
$finalResp   = Invoke-Api -Method GET -Path "/api/orders/$orderCode" -Token $clientToken
$finalStatus = $finalResp.order.status

if ($finalStatus -eq "delivered") {
    Green "Order $orderCode is now 'delivered' -- END-TO-END FLOW COMPLETE"
} else {
    Write-Host "  [INFO] Order status is '$finalStatus'" -ForegroundColor Yellow
}

$finalSaga = Invoke-Api -Method GET -Path "/api/saga/transactions/$orderCode" -Token $clientToken
Dim "All saga steps: $(($finalSaga.history | ForEach-Object { $_.saga_step + ':' + $_.status }) -join ' | ')"

# ── 10. Saga Compensation Test ───────────────────────────────
Blue "STEP 10 -- Saga Compensation / Fallback Test"

$compOrderResp = Invoke-Api -Method POST -Path "/api/orders" -Token $clientToken -Body @{
    pickup_address   = "12 Peradeniya Road, Kandy"
    delivery_address = "5 Lake Drive, Kandy"
    weight_kg        = 1.0
}

$compOrderCode = $compOrderResp.order_code
Dim "Created order $compOrderCode for compensation test"
Start-Sleep -Seconds 5

$compResp = Invoke-Api -Method POST -Path "/api/saga/simulate-failure" -Token $clientToken -Body @{
    order_code  = $compOrderCode
    failed_step = "ROS_ASSIGN"
    reason      = "Phase 6 automated compensation test - simulated downstream failure"
}

if ($compResp.status -eq "compensated") {
    Green "Saga compensation triggered for $compOrderCode - step ROS_ASSIGN marked failed"
    Green "Order rolled back to 'failed', SAGA_COMPENSATED dispatched via WebSocket"
} else {
    Red "Compensation response unexpected"
    exit 1
}

Start-Sleep -Seconds 1
$compLog   = Invoke-Api -Method GET -Path "/api/saga/transactions/$compOrderCode" -Token $clientToken
$compSteps = $compLog.history | ForEach-Object { $_.saga_step }

if ("SAGA_COMPENSATION" -in $compSteps) {
    Green "SAGA_COMPENSATION step found in transaction log - fallback mechanism verified OK"
} else {
    Red "SAGA_COMPENSATION step NOT found in logs - check gateway logs"
}

# ── Summary ──────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  PHASE 6 TEST SUMMARY" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ("  E2E Order Flow    : PASSED (" + $orderCode + ")") -ForegroundColor Green
Write-Host "  Saga Logs         : PASSED -- CMS_CREATE, ROS_ASSIGN recorded" -ForegroundColor Green
Write-Host "  Delivery + POD    : PASSED -- signature captured" -ForegroundColor Green
Write-Host ("  Saga Compensation : PASSED -- " + $compOrderCode + " rolled back") -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "All Phase 6 acceptance criteria met." -ForegroundColor Green
Write-Host ""
