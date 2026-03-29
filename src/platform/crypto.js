'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

function parseKey(raw) {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  // Accept 64-char hex or base64/utf8 that expands to 32 bytes.
  if (/^[a-fA-F0-9]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  try {
    const b64 = Buffer.from(value, 'base64');
    if (b64.length === 32) return b64;
  } catch (_) {
    // ignore
  }

  const utf8 = Buffer.from(value, 'utf8');
  if (utf8.length === 32) return utf8;

  return null;
}

function getKey() {
  const key = parseKey(process.env.PLATFORM_ENCRYPTION_KEY || '');
  if (!key) return null;
  return key;
}

function encryptJson(data) {
  const key = getKey();
  if (!key) {
    return {
      encrypted: false,
      payload: data,
    };
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: true,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    value: encrypted.toString('base64'),
  };
}

function decryptJson(blob) {
  if (!blob || typeof blob !== 'object') return null;

  if (blob.encrypted === false && Object.prototype.hasOwnProperty.call(blob, 'payload')) {
    return blob.payload;
  }

  if (!blob.encrypted) return blob;

  const key = getKey();
  if (!key) {
    throw new Error('PLATFORM_ENCRYPTION_KEY is required to decrypt integration config');
  }

  const iv = Buffer.from(blob.iv || '', 'base64');
  const tag = Buffer.from(blob.tag || '', 'base64');
  const value = Buffer.from(blob.value || '', 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(value), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = {
  encryptJson,
  decryptJson,
  parseKey,
};
