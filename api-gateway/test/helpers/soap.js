'use strict';

/**
 * Helpers for faking the CMS SOAP service with nock.
 *
 * CMS returns a JSON document serialised as text inside the `<tns:{method}Result>`
 * element (see cms-service/app.py, which json.dumps()s every result). The XML
 * payload therefore has to be escaped exactly the way the gateway's own
 * escapeXml() would escape it, otherwise parseStringPromise produces different
 * node names than production.
 */

const { escapeXml } = require('../../app');

const SOAP_URL = process.env.CMS_SOAP_URL;

/**
 * Build a SOAP 1.1 response envelope carrying `payload` as `{method}Result`.
 *
 * @param {string} method   e.g. "authenticate_client"
 * @param {object|string} payload  object is JSON-encoded first
 * @param {string} [resultKey]      override the element name
 */
function soapResponse(method, payload, resultKey) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const key = resultKey || `${method}Result`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '                  xmlns:tns="swifttrack.cms">',
    '  <soapenv:Body>',
    `    <tns:${method}Response>`,
    `      <tns:${key}>${escapeXml(body)}</tns:${key}>`,
    `    </tns:${method}Response>`,
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

/** Absolute URL of the CMS SOAP endpoint (from test/setup.js). */
function soapUrl() {
  return SOAP_URL;
}

module.exports = { soapResponse, soapUrl };
