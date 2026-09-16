#!/usr/bin/env node
/**
 * Differential check of the SigV4 presigner against botocore, AWS's own
 * implementation.
 *
 * The unit test in apps/api/src/storage/s3.test.ts asserts against vectors
 * this script produced, which is enough to catch a regression but does not by
 * itself prove the vectors were ever right. This re-establishes that: it
 * drives botocore over the same inputs and compares signature and URL.
 *
 * Requires botocore (`pip install botocore`). Skips with a clear message when
 * it is unavailable, so it is safe to run anywhere.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { presignWith } from '../apps/api/dist/storage/s3.js';

const CASES = [
  {
    name: 'virtual-hosted GET',
    config: {
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      forcePathStyle: false,
    },
    request: { method: 'GET', key: 'test.txt', expiresInSeconds: 86_400 },
  },
  {
    name: 'path-style PUT, nested key',
    config: {
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'howlow-dev',
      accessKey: 'minioadmin',
      secretKey: 'minioadmin-secret',
      forcePathStyle: true,
    },
    request: {
      method: 'PUT',
      key: 'products/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg',
      expiresInSeconds: 900,
    },
  },
  {
    name: 'path-style PUT with signed content headers',
    config: {
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'howlow-dev',
      accessKey: 'minioadmin',
      secretKey: 'minioadmin-secret',
      forcePathStyle: true,
    },
    request: {
      method: 'PUT',
      key: 'products/a/b/c.png',
      expiresInSeconds: 900,
      signedHeaders: { 'content-type': 'image/png', 'content-length': '2048' },
    },
  },
  {
    name: 'path-style DELETE in another region',
    config: {
      endpoint: 'http://localhost:9000',
      region: 'eu-west-1',
      bucket: 'howlow-dev',
      accessKey: 'minioadmin',
      secretKey: 'minioadmin-secret',
      forcePathStyle: true,
    },
    request: { method: 'DELETE', key: 'products/a/b/c.webp', expiresInSeconds: 60 },
  },
];

const REFERENCE = `
import json, sys
from urllib.parse import urlparse, parse_qs
from botocore.credentials import Credentials
from botocore.awsrequest import AWSRequest
from botocore.auth import S3SigV4QueryAuth

out = []
for c in json.load(sys.stdin):
    cfg, req_spec = c["config"], c["request"]
    if cfg["forcePathStyle"]:
        url = f"{cfg['endpoint']}/{cfg['bucket']}/{req_spec['key']}"
    else:
        scheme, host = cfg["endpoint"].split("://")
        url = f"{scheme}://{cfg['bucket']}.{host}/{req_spec['key']}"
    auth = S3SigV4QueryAuth(
        Credentials(cfg["accessKey"], cfg["secretKey"]), "s3", cfg["region"],
        expires=req_spec["expiresInSeconds"])
    req = AWSRequest(method=req_spec["method"], url=url,
                     headers=req_spec.get("signedHeaders") or {})
    auth.add_auth(req)
    q = parse_qs(urlparse(req.url).query)
    out.append({"amzDate": q["X-Amz-Date"][0], "signature": q["X-Amz-Signature"][0],
                "base": req.url.split("?")[0]})
print(json.dumps(out))
`;

const probe = spawnSync('python3', ['-c', 'import botocore'], { stdio: 'ignore' });
if (probe.status !== 0) {
  console.log('verify-sigv4: botocore is not installed; skipping (pip install botocore)');
  process.exit(0);
}

const run = spawnSync('python3', ['-c', REFERENCE], {
  input: JSON.stringify(CASES),
  encoding: 'utf8',
});
if (run.status !== 0) {
  console.error(`verify-sigv4: reference failed\n${run.stderr}`);
  process.exit(1);
}

/** botocore reads its own clock, so the signed instant comes back with the result. */
function instantOf(amzDate) {
  const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(
    9,
    11,
  )}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
  return new Date(iso);
}

const reference = JSON.parse(run.stdout);
let failures = 0;

CASES.forEach((testCase, index) => {
  const expected = reference[index];
  const actual = presignWith(testCase.config, {
    ...testCase.request,
    now: instantOf(expected.amzDate),
  });
  const sameUrl = actual.url.split('?')[0] === expected.base;
  const sameSignature = actual.signature === expected.signature;

  if (sameUrl && sameSignature) {
    console.log(`verify-sigv4: MATCH  ${testCase.name}`);
    return;
  }
  failures += 1;
  console.error(`verify-sigv4: DIFFER ${testCase.name}`);
  console.error(`  ours      ${actual.url.split('?')[0]} ${actual.signature}`);
  console.error(`  botocore  ${expected.base} ${expected.signature}`);
});

if (failures > 0) {
  console.error(`verify-sigv4: ${failures} case(s) disagree with botocore`);
  process.exit(1);
}
console.log('verify-sigv4: OK — every case matches botocore');
