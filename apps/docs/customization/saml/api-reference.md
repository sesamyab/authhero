---
title: SAML API Reference
description: Complete API reference for the @authhero/saml package including the parsed AuthnRequest shape, SAMLResponseJSON, schemas and signing methods.
---

# SAML API Reference

This document provides a complete API reference for the `@authhero/saml` package.

## Types

### Parsed AuthnRequest

`parseSamlRequestQuery` returns the AuthnRequest as parsed XML, validated by `samlRequestSchema`. The package does not export a named type for it; use `z.infer<typeof samlRequestSchema>`:

```typescript
type ParsedAuthnRequest = {
  "samlp:AuthnRequest": {
    "saml:Issuer": { "#text": string };
    "@_ID": string;
    "@_IssueInstant": string;
    "@_Destination": string;
    "@_AssertionConsumerServiceURL"?: string;
    "@_ProtocolBinding"?: string;
    "@_ForceAuthn"?: boolean;
    "@_Version": string;
  };
};
```

**Properties of `samlp:AuthnRequest`:**

- `saml:Issuer` - The entity ID of the service provider requesting authentication
- `@_ID` - Unique identifier for the SAML request
- `@_IssueInstant` - Timestamp when the request was created
- `@_Destination` - The intended destination of the request
- `@_AssertionConsumerServiceURL` - Where the response should be sent
- `@_ForceAuthn` - Whether to force re-authentication
- `@_ProtocolBinding` - The SAML protocol binding to use

### SAMLResponseJSON

SAML response data structure.

```typescript
interface SAMLResponseJSON {
  audience: string;
  sessionIndex: string;
  nameIdentifier: string;
  nameIdentifierFormat: string;
  acsUrl: string;
  recipient: string;
  issuer: string;
  inResponseTo?: string;
  attributes?: Record<string, string>;
  signResponse?: boolean;
}
```

**Properties:**

- `audience` - The intended audience (typically the SP entity ID)
- `sessionIndex` - Unique session identifier
- `nameIdentifier` - The subject identifier (usually user ID)
- `nameIdentifierFormat` - Format of the name identifier
- `acsUrl` - Assertion Consumer Service URL
- `recipient` - The recipient of the assertion
- `issuer` - The identity provider issuer
- `inResponseTo` - ID of the request being responded to
- `attributes` - Custom SAML attributes to include
- `signResponse` - Whether to sign the response

### SamlSigner

Interface for SAML signing implementations.

```typescript
interface SamlSigner {
  signSAML(
    xmlContent: string,
    privateKey: string,
    publicCert: string,
  ): Promise<string>;
}
```

**Methods:**

- `signSAML(xmlContent, privateKey, publicCert)` - Sign SAML XML and return signed XML
  - `xmlContent` - The XML content to sign
  - `privateKey` - The private key in PEM format
  - `publicCert` - The public certificate

## Classes

### HttpSamlSigner

HTTP-based SAML signer that delegates signing to an external service.

```typescript
class HttpSamlSigner implements SamlSigner {
  constructor(url: string);
  signSAML(
    xmlContent: string,
    privateKey: string,
    publicCert: string,
  ): Promise<string>;
}
```

**Constructor:**

- `url` - HTTP endpoint URL for signing

**Example:**

```typescript
import { HttpSamlSigner } from "authhero";

const signer = new HttpSamlSigner("https://signing-service.com/sign");
const signedXml = await signer.signSAML(xmlContent, privateKey, publicCert);
```

### LocalSamlSigner

Local SAML signer using xml-crypto (Node.js only).

```typescript
class LocalSamlSigner implements SamlSigner {
  constructor();
  signSAML(
    xmlContent: string,
    privateKey: string,
    publicCert: string,
  ): Promise<string>;
}
```

**Example:**

```typescript
import { LocalSamlSigner } from "@authhero/saml/local-signer";

const signer = new LocalSamlSigner();
const signedXml = await signer.signSAML(xmlContent, privateKey, publicCert);
```

::: warning
`LocalSamlSigner` requires Node.js and cannot be used in edge/serverless environments.
:::

## Functions

### parseSamlRequestQuery

Parse the `SAMLRequest` query parameter of an HTTP-Redirect request.

```typescript
function parseSamlRequestQuery(
  samlRequestQuery: string,
): Promise<z.infer<typeof samlRequestSchema>>;
```

**Parameters:**

- `samlRequestQuery` - The value of the `SAMLRequest` query parameter: base64, deflate-compressed or not

**Returns:** The [parsed AuthnRequest](#parsed-authnrequest)

**Throws:** Error if parsing fails

**Example:**

```typescript
import { parseSamlRequestQuery } from "@authhero/saml";

const url = new URL(request.url);
const parsed = await parseSamlRequestQuery(url.searchParams.get("SAMLRequest")!);
const authnRequest = parsed["samlp:AuthnRequest"];

console.log(authnRequest["saml:Issuer"]["#text"]); // SP entity ID
console.log(authnRequest["@_AssertionConsumerServiceURL"]); // Where to send response
```

### createSamlResponse

Create a SAML response XML string.

```typescript
function createSamlResponse(
  params: SAMLResponseJSON,
  signer?: SamlSigner,
): Promise<string>;
```

**Parameters:**

- `params` - SAML response parameters
- `signer` - Optional signer to sign the response

**Returns:** SAML response XML string (signed if signer provided)

**Example:**

```typescript
import { createSamlResponse, HttpSamlSigner } from "@authhero/saml";

const signer = new HttpSamlSigner("https://signing-service.com/sign");

const response = await createSamlResponse(
  {
    audience: "https://sp.example.com",
    sessionIndex: "session-123",
    nameIdentifier: "user@example.com",
    nameIdentifierFormat:
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    acsUrl: "https://sp.example.com/acs",
    recipient: "https://sp.example.com/acs",
    issuer: "https://idp.example.com",
    inResponseTo: "request-id-123",
    attributes: {
      email: "user@example.com",
      firstName: "John",
      lastName: "Doe",
    },
    signResponse: true,
  },
  signer,
);

console.log(response); // Signed SAML XML
```

### createSamlMetadata

Generate SAML identity provider (IdP) metadata — an `IDPSSODescriptor` for the service providers that log in through AuthHero.

```typescript
function createSamlMetadata(params: {
  issuer: string;
  callbackUrl: string;
  certificate: string;
}): string;
```

**Parameters:**

- `issuer` - The entity ID of the identity provider
- `callbackUrl` - The callback URL (ACS URL)
- `certificate` - X.509 certificate for signing

**Returns:** SAML metadata XML string

**Example:**

```typescript
import { createSamlMetadata } from "@authhero/saml";

const metadata = createSamlMetadata({
  issuer: "https://idp.example.com",
  callbackUrl: "https://idp.example.com/callback",
  certificate: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
});

console.log(metadata); // SAML metadata XML
```

### inflateDecompress

Decompress and inflate a SAML request string.

```typescript
function inflateDecompress(input: string): Promise<string>;
```

**Parameters:**

- `input` - Base64-encoded, deflated SAML request

**Returns:** Decompressed XML string

**Example:**

```typescript
import { inflateDecompress } from "@authhero/saml";

const compressed = "nZFBb4MwDIX..."; // Base64 deflated
const xml = await inflateDecompress(compressed);
console.log(xml); // <samlp:AuthnRequest ...>
```

## Zod Schemas

The package includes Zod schemas for runtime validation:

### samlRequestSchema

```typescript
import { samlRequestSchema } from "@authhero/saml";

const parsed = samlRequestSchema.parse(data);
```

### samlResponseJsonSchema

```typescript
import { samlResponseJsonSchema } from "@authhero/saml";

const validated = samlResponseJsonSchema.parse(responseData);
```

## Entry Points

### @authhero/saml

Main entry point with all functionality:

```typescript
import {
  // Types
  type SAMLResponseJSON,
  type SamlSigner,

  // Classes
  HttpSamlSigner,
  LocalSamlSigner,

  // Functions
  parseSamlRequestQuery,
  createSamlResponse,
  createSamlMetadata,
  inflateDecompress,

  // Schemas
  samlRequestSchema,
  samlResponseJsonSchema,
} from "@authhero/saml";
```

### @authhero/saml/core

Core functionality without LocalSamlSigner (no xml-crypto):

```typescript
import {
  // Types
  type SAMLResponseJSON,
  type SamlSigner,

  // Classes
  HttpSamlSigner,
  // Note: LocalSamlSigner NOT included

  // Functions
  parseSamlRequestQuery,
  createSamlResponse,
  createSamlMetadata,
  inflateDecompress,

  // Schemas
  samlRequestSchema,
  samlResponseJsonSchema,
} from "@authhero/saml/core";
```

### @authhero/saml/local-signer

Only LocalSamlSigner class:

```typescript
import { LocalSamlSigner } from "@authhero/saml/local-signer";
```

## Error Handling

All functions may throw errors that should be handled:

```typescript
import { parseSamlRequestQuery } from "@authhero/saml";

try {
  const request = parseSamlRequestQuery(query);
  // Process request
} catch (error) {
  console.error("Failed to parse SAML request:", error);
  // Handle error appropriately
}
```

Common error scenarios:

- Invalid base64 encoding in SAMLRequest
- Malformed XML in SAML request
- Missing required fields
- Signing service unavailable (HttpSamlSigner)
- Invalid parameters
