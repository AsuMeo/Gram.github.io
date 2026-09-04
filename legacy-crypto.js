/*
 * Legacy Meow Stream codec compatibility layer.
 *
 * The previous client stored text fields with a browser-side MEOWAES256 prefix.
 * This decoder remains read-only in the new client so existing RTDB records stay
 * visible while every new record is written as an interoperable, plain RTDB object.
 * Do not treat this legacy mechanism as access control: production security belongs
 * in Firebase Authentication and Realtime Database Rules.
 */
(function (global) {
"use strict";

  var LegacyMeowCrypto = (function() {
      var MASTER_KEY = [
        0x4D, 0x45, 0x4F, 0x57, 0x5F, 0x53, 0x54, 0x52,
        0x45, 0x41, 0x4D, 0x5F, 0x41, 0x45, 0x53, 0x32,
        0x35, 0x36, 0x5F, 0x53, 0x45, 0x43, 0x52, 0x45,
        0x54, 0x5F, 0x4B, 0x45, 0x59, 0x5F, 0x33, 0x32
      ];

      var SBOX = [
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
      ];

      var ISBOX = new Array(256);
      for (var i = 0; i < 256; i++) ISBOX[SBOX[i]] = i;

      var RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

      function keyExpansion(key) {
        var w = new Array(60);
        for (var i = 0; i < 8; i++) {
          w[i] = [key[4*i], key[4*i+1], key[4*i+2], key[4*i+3]];
        }
        for (var i = 8; i < 60; i++) {
          var temp = w[i-1].slice();
          if (i % 8 === 0) {
            temp = [SBOX[temp[1]] ^ RCON[i/8], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]];
          } else if (i % 8 === 4) {
            temp = [SBOX[temp[0]], SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]]];
          }
          w[i] = [w[i-8][0] ^ temp[0], w[i-8][1] ^ temp[1], w[i-8][2] ^ temp[2], w[i-8][3] ^ temp[3]];
        }
        return w;
      }

      function gmul(a, b) {
        var p = 0;
        for (var counter = 0; counter < 8; counter++) {
          if ((b & 1) !== 0) p ^= a;
          var hi_bit_set = (a & 0x80) !== 0;
          a = (a << 1) & 0xff;
          if (hi_bit_set) a ^= 0x1b;
          b >>= 1;
        }
        return p;
      }

      function cipherBlock(block, w) {
        var state = [[],[],[],[]];
        for (var i = 0; i < 4; i++) {
          for (var j = 0; j < 4; j++) state[j][i] = block[i*4+j];
        }
        for (var i = 0; i < 4; i++) {
          for (var j = 0; j < 4; j++) state[j][i] ^= w[i][j];
        }
        for (var round = 1; round <= 14; round++) {
          for (var r = 0; r < 4; r++) {
            for (var c = 0; c < 4; c++) state[r][c] = SBOX[state[r][c]];
          }
          var t1 = state[1][0]; state[1][0] = state[1][1]; state[1][1] = state[1][2]; state[1][2] = state[1][3]; state[1][3] = t1;
          var t2_0 = state[2][0], t2_1 = state[2][1]; state[2][0] = state[2][2]; state[2][1] = state[2][3]; state[2][2] = t2_0; state[2][3] = t2_1;
          var t3 = state[3][3]; state[3][3] = state[3][2]; state[3][2] = state[3][1]; state[3][1] = state[3][0]; state[3][0] = t3;
          if (round < 14) {
            for (var c = 0; c < 4; c++) {
              var s0 = state[0][c], s1 = state[1][c], s2 = state[2][c], s3 = state[3][c];
              state[0][c] = gmul(s0, 2) ^ gmul(s1, 3) ^ s2 ^ s3;
              state[1][c] = s0 ^ gmul(s1, 2) ^ gmul(s2, 3) ^ s3;
              state[2][c] = s0 ^ s1 ^ gmul(s2, 2) ^ gmul(s3, 3);
              state[3][c] = gmul(s0, 3) ^ s1 ^ s2 ^ gmul(s3, 2);
            }
          }
          for (var c = 0; c < 4; c++) {
            for (var r = 0; r < 4; r++) state[r][c] ^= w[round*4 + c][r];
          }
        }
        var out = new Array(16);
        for (var i = 0; i < 4; i++) {
          for (var j = 0; j < 4; j++) out[i*4+j] = state[j][i];
        }
        return out;
      }

      function invCipherBlock(block, w) {
        var state = [[],[],[],[]];
        for (var i = 0; i < 4; i++) {
          for (var j = 0; j < 4; j++) state[j][i] = block[i*4+j];
        }
        for (var i = 0; i < 4; i++) {
          for (var j = 0; j < 4; j++) state[j][i] ^= w[14*4 + i][j];
        }
        for (var round = 13; round >= 0; round--) {
          var t1 = state[1][3]; state[1][3] = state[1][2]; state[1][2] = state[1][1]; state[1][1] = state[1][0]; state[1][0] = t1;
          var t2_0 = state[2][0], t2_1 = state[2][1]; state[2][0] = state[2][2]; state[2][1] = state[2][3]; state[2][2] = t2_0; state[2][3] = t2_1;
          var t3 = state[3][0]; state[3][0] = state[3][1]; state[3][1] = state[3][2]; state[3][2] = state[3][3]; state[3][3] = t3;
          for (var r = 0; r < 4; r++) {
            for (var c = 0; c < 4; c++) state[r][c] = ISBOX[state[r][c]];
          }
          for (var c = 0; c < 4; c++) {
            for (var r = 0; r < 4; r++) state[r][c] ^= w[round*4 + c][r];
          }
          if (round > 0) {
            for (var c = 0; c < 4; c++) {
              var s0 = state[0][c], s1 = state[1][c], s2 = state[2][c], s3 = state[3][c];
              state[0][c] = gmul(s0, 0x0e) ^ gmul(s1, 0x0b) ^ gmul(s2, 0x0d) ^ gmul(s3, 0x09);
              state[1][c] = gmul(s0, 0x09) ^ gmul(s1, 0x0e) ^ gmul(s2, 0x0b) ^ gmul(s3, 0x0d);
              state[2][c] = gmul(s0, 0x0d) ^ gmul(s1, 0x09) ^ gmul(s2, 0x0e) ^ gmul(s3, 0x0b);
              state[3][c] = gmul(s0, 0x0b) ^ gmul(s1, 0x0d) ^ gmul(s2, 0x09) ^ gmul(s3, 0x0e);
            }
          }
        }
        var out = new Array(16);
        for (var i = 0; i < 4; i++) {
          for (var j = 0; j < 4; j++) out[i*4+j] = state[j][i];
        }
        return out;
      }

      function stringToUtf8Bytes(str) {
        var bytes = [];
        for (var i = 0; i < str.length; i++) {
          var code = str.charCodeAt(i);
          if (code < 0x80) bytes.push(code);
          else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6));
            bytes.push(0x80 | (code & 0x3f));
          } else if (code < 0xd800 || code >= 0xe000) {
            bytes.push(0xe0 | (code >> 12));
            bytes.push(0x80 | ((code >> 6) & 0x3f));
            bytes.push(0x80 | (code & 0x3f));
          } else {
            i++;
            code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
            bytes.push(0xf0 | (code >> 18));
            bytes.push(0x80 | ((code >> 12) & 0x3f));
            bytes.push(0x80 | ((code >> 6) & 0x3f));
            bytes.push(0x80 | (code & 0x3f));
          }
        }
        return bytes;
      }

      function utf8BytesToString(bytes) {
        var str = "";
        var i = 0;
        while (i < bytes.length) {
          var c = bytes[i++];
          if (c > 127) {
            if (c > 191 && c < 224) {
              c = ((c & 31) << 6) | (bytes[i++] & 63);
            } else if (c > 223 && c < 240) {
              c = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
            } else if (c > 239 && c < 248) {
              c = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
            }
          }
          if (c <= 0xffff) {
            str += String.fromCharCode(c);
          } else {
            c -= 0x10000;
            str += String.fromCharCode((c >> 10) | 0xd800, (c & 0x3ff) | 0xdc00);
          }
        }
        return str;
      }

      function getRandomBytes(n) {
        var arr = new Uint8Array(n);
        if (window.crypto && window.crypto.getRandomValues) {
          window.crypto.getRandomValues(arr);
        } else {
          for (var i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
        }
        var result = [];
        for (var i = 0; i < n; i++) result.push(arr[i]);
        return result;
      }

      function deriveKey(salt) {
        var key = MASTER_KEY.slice();
        for (var i = 0; i < key.length; i++) {
          key[i] = key[i] ^ salt[i % salt.length];
        }
        return keyExpansion(key);
      }

      function bytesToBase64(bytes) {
        var bin = "";
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      }

      function base64ToBytes(b64) {
        var bin = atob(b64);
        var bytes = [];
        for (var i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i));
        return bytes;
      }

      var PREFIX = "MEOWAES256:";

      function encryptString(str) {
        if (typeof str !== "string") return str;
        if (str.startsWith(PREFIX)) return str;

        var plainBytes = stringToUtf8Bytes(str);
        var pad = 16 - (plainBytes.length % 16);
        for (var i = 0; i < pad; i++) plainBytes.push(pad);

        var salt = getRandomBytes(8);
        var iv = getRandomBytes(16);
        var expandedKey = deriveKey(salt);

        var cipherBytes = [];
        var prevBlock = iv.slice();

        for (var b = 0; b < plainBytes.length; b += 16) {
          var block = plainBytes.slice(b, b + 16);
          for (var i = 0; i < 16; i++) block[i] ^= prevBlock[i];
          var encrypted = cipherBlock(block, expandedKey);
          for (var i = 0; i < 16; i++) cipherBytes.push(encrypted[i]);
          prevBlock = encrypted.slice();
        }

        var fullPayload = salt.concat(iv).concat(cipherBytes);
        return PREFIX + bytesToBase64(fullPayload);
      }

      function decryptString(encStr) {
        if (typeof encStr !== "string") return encStr;
        if (!encStr.startsWith(PREFIX)) return encStr;

        try {
          var rawB64 = encStr.slice(PREFIX.length);
          var fullBytes = base64ToBytes(rawB64);

          if (fullBytes.length < 24) return encStr;

          var salt = fullBytes.slice(0, 8);
          var iv = fullBytes.slice(8, 24);
          var cipherBytes = fullBytes.slice(24);

          var expandedKey = deriveKey(salt);
          var plainBytes = [];
          var prevBlock = iv.slice();

          for (var b = 0; b < cipherBytes.length; b += 16) {
            var block = cipherBytes.slice(b, b + 16);
            var decrypted = invCipherBlock(block, expandedKey);
            for (var i = 0; i < 16; i++) plainBytes.push(decrypted[i] ^ prevBlock[i]);
            prevBlock = block.slice();
          }

          var pad = plainBytes[plainBytes.length - 1];
          if (pad > 0 && pad <= 16) {
            plainBytes = plainBytes.slice(0, plainBytes.length - pad);
          }

          return utf8BytesToString(plainBytes);
        } catch(e) {
          return encStr;
        }
      }

      function processData(val, encMode) {
        if (val === null || val === undefined) return val;

        if (typeof val === "string") {
          return encMode ? encryptString(val) : decryptString(val);
        }

        if (typeof val === "boolean" || typeof val === "number") {
          return val;
        }

        if (Array.isArray(val)) {
          return val.map(function(item) { return processData(item, encMode); });
        }

        if (typeof val === "object") {
          var res = {};
          Object.keys(val).forEach(function(k) {
            res[k] = processData(val[k], encMode);
          });
          return res;
        }

        return val;
      }

      return {
        encrypt: function(val) { return processData(val, true); },
        decrypt: function(val) { return processData(val, false); },
        encryptString: encryptString,
        decryptString: decryptString
      };
    })();

  // Intentionally expose only the reader in the new application. New RTDB values
  // are plain compatible JSON; this layer exists solely to keep old records visible.
  global.LegacyMeowCrypto = {
    decrypt: LegacyMeowCrypto.decrypt,
    decryptString: LegacyMeowCrypto.decryptString
  };
})(window);
