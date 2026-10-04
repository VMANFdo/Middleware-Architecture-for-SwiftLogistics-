'use strict';

const { escapeXml, buildSoapEnvelope, findSoapResult } = require('../app');

describe('escapeXml', () => {
  test('escapes the five XML special characters', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  test('leaves ordinary text untouched', () => {
    expect(escapeXml('45 Galle Road, Colombo 03')).toBe('45 Galle Road, Colombo 03');
  });

  test('coerces null and undefined to an empty string', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });

  test('coerces numbers to strings', () => {
    expect(escapeXml(2.4)).toBe('2.4');
  });

  test('escapes markup that would otherwise break the envelope', () => {
    const escaped = escapeXml('<script>alert("x")</script>');
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });
});

describe('buildSoapEnvelope', () => {
  test('produces a SOAP 1.1 envelope targeting the CMS namespace', () => {
    const xml = buildSoapEnvelope('create_order', { client_code: 'CLT001' });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<soapenv:Envelope');
    expect(xml).toContain('xmlns:tns="swifttrack.cms"');
    expect(xml).toContain('<tns:create_order>');
    expect(xml).toContain('</tns:create_order>');
    expect(xml).toContain('<soapenv:Body>');
  });

  test('serialises every param as a tns-prefixed child element', () => {
    const xml = buildSoapEnvelope('authenticate_client', {
      email: 'techmart@example.com',
      password: 'password123',
    });

    expect(xml).toContain('<tns:email>techmart@example.com</tns:email>');
    expect(xml).toContain('<tns:password>password123</tns:password>');
  });

  test('escapes parameter values so XML stays parseable', () => {
    const xml = buildSoapEnvelope('create_order', {
      pickup_address: 'A & B <C> "D"',
    });

    expect(xml).toContain('A &amp; B &lt;C&gt; &quot;D&quot;');
    expect(xml).not.toContain('<C>');
  });

  test('renders an empty param set as an empty method element', () => {
    const xml = buildSoapEnvelope('ping', {});
    expect(xml).toContain('<tns:ping></tns:ping>');
  });
});

describe('findSoapResult', () => {
  test('finds a result key at the top level', () => {
    const node = { authenticate_clientResult: '{"success":true}' };
    expect(findSoapResult(node, 'authenticate_clientResult')).toBe('{"success":true}');
  });

  test('finds a result key nested in the response envelope', () => {
    const node = {
      'soapenv:Envelope': {
        'soapenv:Body': {
          'tns:create_orderResponse': {
            'tns:create_orderResult': '{"success":true,"order_code":"ORD-0001"}',
          },
        },
      },
    };
    expect(findSoapResult(node, 'create_orderResult')).toBe(
      '{"success":true,"order_code":"ORD-0001"}',
    );
  });

  test('matches keys that merely end with the result key', () => {
    const node = { 'ns1:authenticate_clientResult': 'payload' };
    expect(findSoapResult(node, 'authenticate_clientResult')).toBe('payload');
  });

  test('returns null when the result element is absent', () => {
    expect(findSoapResult({ soapenv: { Body: {} } }, 'create_orderResult')).toBeNull();
  });

  test('returns null for non-object input', () => {
    expect(findSoapResult(null, 'create_orderResult')).toBeNull();
    expect(findSoapResult('not-an-object', 'create_orderResult')).toBeNull();
    expect(findSoapResult(undefined, 'create_orderResult')).toBeNull();
  });

  test('returns null when a nested result value is empty', () => {
    const node = { Body: { Response: { create_orderResult: '' } } };
    expect(findSoapResult(node, 'create_orderResult')).toBeNull();
  });
});
