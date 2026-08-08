CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Clients Table
CREATE TABLE IF NOT EXISTS clients (
    client_id VARCHAR(50) PRIMARY KEY,
    company_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    contract_type VARCHAR(50) DEFAULT 'STANDARD'
);

-- Drivers Table
CREATE TABLE IF NOT EXISTS drivers (
    driver_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    vehicle_type VARCHAR(50) DEFAULT 'VAN'
);

-- Orders Table
CREATE TABLE IF NOT EXISTS orders (
    order_id VARCHAR(50) PRIMARY KEY,
    client_id VARCHAR(50) REFERENCES clients(client_id),
    pickup_address TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    pickup_lat NUMERIC(10, 6),
    pickup_lng NUMERIC(10, 6),
    delivery_lat NUMERIC(10, 6),
    delivery_lng NUMERIC(10, 6),
    weight NUMERIC(6, 2),
    status VARCHAR(50) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Packages Table
CREATE TABLE IF NOT EXISTS packages (
    package_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES orders(order_id),
    barcode VARCHAR(100) UNIQUE NOT NULL,
    warehouse_location VARCHAR(50),
    status VARCHAR(50) DEFAULT 'RECEIVED'
);

-- Routes Table
CREATE TABLE IF NOT EXISTS routes (
    route_id VARCHAR(50) PRIMARY KEY,
    driver_id VARCHAR(50) REFERENCES drivers(driver_id),
    date DATE DEFAULT CURRENT_DATE,
    status VARCHAR(50) DEFAULT 'ASSIGNED'
);

-- Route Stops Table
CREATE TABLE IF NOT EXISTS route_stops (
    id SERIAL PRIMARY KEY,
    route_id VARCHAR(50) REFERENCES routes(route_id),
    order_id VARCHAR(50) REFERENCES orders(order_id),
    sequence_number INT NOT NULL,
    estimated_arrival VARCHAR(50),
    status VARCHAR(50) DEFAULT 'PENDING'
);

-- Transaction Logs (Saga Monitoring)
CREATE TABLE IF NOT EXISTS transaction_logs (
    transaction_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES orders(order_id),
    cms_status VARCHAR(50) DEFAULT 'PENDING',
    ros_status VARCHAR(50) DEFAULT 'PENDING',
    wms_status VARCHAR(50) DEFAULT 'PENDING',
    overall_status VARCHAR(50) DEFAULT 'IN_PROGRESS'
);

-- Seed Data (Password: password123)
INSERT INTO clients (client_id, company_name, email, password_hash, contract_type)
VALUES 
  ('CLT001', 'TechMart E-Commerce', 'techmart@example.com', '$2b$10$EpReh5V9p8C.8g3cR2v1eO4xWz3vR9g8c2e1v0w9x8y7z6a5b4c3d', 'PREMIUM'),
  ('CLT002', 'Lanka Retail', 'info@lankaretail.lk', '$2b$10$EpReh5V9p8C.8g3cR2v1eO4xWz3vR9g8c2e1v0w9x8y7z6a5b4c3d', 'STANDARD')
ON CONFLICT (client_id) DO NOTHING;

INSERT INTO drivers (driver_id, name, email, password_hash, vehicle_type)
VALUES 
  ('DRV001', 'Kamal Perera', 'kamal@swiftlogistics.lk', '$2b$10$EpReh5V9p8C.8g3cR2v1eO4xWz3vR9g8c2e1v0w9x8y7z6a5b4c3d', 'VAN'),
  ('DRV002', 'Nimal Silva', 'nimal@swiftlogistics.lk', '$2b$10$EpReh5V9p8C.8g3cR2v1eO4xWz3vR9g8c2e1v0w9x8y7z6a5b4c3d', 'THREE_WHEELER')
ON CONFLICT (driver_id) DO NOTHING;