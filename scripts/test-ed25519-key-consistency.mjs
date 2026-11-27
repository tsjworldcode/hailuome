#!/usr/bin/env node
/** Ed25519 部署门禁 helper 契约：hex/base64 归一、私钥→公钥推导、错配拒绝。 */
import crypto from 'node:crypto';
import {
  assertEd25519KeyPairConsistent,
  deriveEd25519PublicHexFromPkcs8Hex,
  normalizeEd25519PublicKey,
} from './lib/ed25519-key-consistency.mjs';

let pass = 0;
let fail = 0;
function check(name, ok) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (ok) pass += 1;
  else fail += 1;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privHex = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
const pubJwk = publicKey.export({ format: 'jwk' });
const pubHex = Buffer.from(pubJwk.x, 'base64url').toString('hex');
const pubB64 = Buffer.from(pubJwk.x, 'base64url').toString('base64');

console.log('\nEd25519 key consistency\n');
check('hex 公钥归一', normalizeEd25519PublicKey(pubHex) === pubHex);
check('base64 公钥归一为 hex', normalizeEd25519PublicKey(pubB64) === pubHex);
check('非法公钥归一为空', normalizeEd25519PublicKey('not-a-key') === '');
check('私钥推导公钥', deriveEd25519PublicHexFromPkcs8Hex(privHex) === pubHex);
check('成对校验通过', assertEd25519KeyPairConsistent({ privateKeyHex: privHex, publicKey: pubHex }).ok === true);
check('base64 公钥也可通过', assertEd25519KeyPairConsistent({ privateKeyHex: privHex, publicKey: pubB64 }).ok === true);

const other = crypto.generateKeyPairSync('ed25519');
const otherPub = Buffer.from(other.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
let mismatchThrown = false;
try {
  assertEd25519KeyPairConsistent({ privateKeyHex: privHex, publicKey: otherPub });
} catch {
  mismatchThrown = true;
}
check('错配公钥被拒绝', mismatchThrown);

let invalidThrown = false;
try {
  assertEd25519KeyPairConsistent({ privateKeyHex: 'zz', publicKey: pubHex });
} catch {
  invalidThrown = true;
}
check('非法私钥被拒绝', invalidThrown);

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
