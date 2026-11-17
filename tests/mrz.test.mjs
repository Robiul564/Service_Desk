import test from "node:test";
import assert from "node:assert/strict";
import { checkDigit, parseMrz } from "../mrz.mjs";

test("checkDigit: computes correct ICAO 9303 7-3-1 check digits", () => {
  // Pure numbers
  assert.equal(checkDigit("740812"), 2);
  assert.equal(checkDigit("120415"), 9);
  
  // Alphanumeric strings
  assert.equal(checkDigit("L898902C3"), 6);
  assert.equal(checkDigit("A09479295"), 3);
  
  // Fillers count as 0
  assert.equal(checkDigit("<<<<<<"), 0);
});

test("parseMrz: parses ICAO TD3 sample with all required check digits valid", () => {
  const mrz = [
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
    "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
  ].join("\n");
  const result = parseMrz(mrz);
  assert.ok(result);
  assert.equal(result.name, "ANNA MARIA ERIKSSON");
  assert.equal(result.passport_no, "L898902C3");
  assert.equal(result.sex, "F");
  assert.equal(result.dob, "1974-08-12");
  assert.equal(result.passport_expiry, "2012-04-15");
  assert.deepEqual(result.checks, { passport: true, dob: true, expiry: true, composite: true });
  assert.equal(result.score, 3);
});

test("parseMrz: parses Bangladeshi BGD TD3 MRZ and maps nationality", () => {
  const passport = "B12345678";
  const dob = "900101";
  const expiry = "300101";
  const personal = "<".repeat(14);
  const passportCheck = checkDigit(passport);
  const dobCheck = checkDigit(dob);
  const expiryCheck = checkDigit(expiry);
  const personalCheck = checkDigit(personal);
  const compositeCheck = checkDigit(`${passport}${passportCheck}${dob}${dobCheck}${expiry}${expiryCheck}${personal}${personalCheck}`);
  const line1 = `P<BGDRAHMAN<<RAHMAN<MIA${"<".repeat(44 - 23)}`.slice(0, 44);
  const line2 = `${passport}${passportCheck}BGD${dob}${dobCheck}M${expiry}${expiryCheck}${personal}${personalCheck}${compositeCheck}`;
  
  assert.equal(line2.length, 44);
  const result = parseMrz(`${line1}\n${line2}`);
  assert.ok(result);
  assert.equal(result.nationality, "Bangladeshi");
  assert.equal(result.passport_no, passport);
  assert.equal(result.sex, "M");
  assert.deepEqual(result.checks, { passport: true, dob: true, expiry: true, composite: true });
});

test("parseMrz: correctly corrects OCR confusion characters (O/0, I/1, Z/2) in dates", () => {
  // In line 2: dob is "74O812" (letter O instead of digit 0)
  const line1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
  const line2 = "L898902C36UTO74O8122F1204159ZE184226B<<<<<10";
  const result = parseMrz(`${line1}\n${line2}`);
  assert.ok(result);
  assert.equal(result.dob, "1974-08-12");
  assert.equal(result.checks.dob, true);
});

test("parseMrz: handles single names without given name", () => {
  const passport = "A01234567";
  const pCheck = checkDigit(passport);
  const line1 = `P<BGDCHOKDER<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`.slice(0, 44);
  const line2 = `${passport}${pCheck}BGD9205108M3205104<<<<<<<<<<<<<<0`;
  const result = parseMrz(`${line1}\n${line2}`);
  assert.ok(result);
  assert.equal(result.name, "CHOKDER");
});

test("parseMrz: discards surrounding OCR noise and selects best candidate", () => {
  const noisyOcr = [
    "REPUBLIC OF BANGLADESH",
    "PASSPORT NO / PASSEPORT",
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
    "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
    "SOME RANDOM SCANNER FOOTER"
  ].join("\n");
  const result = parseMrz(noisyOcr);
  assert.ok(result);
  assert.equal(result.name, "ANNA MARIA ERIKSSON");
  assert.equal(result.score, 3);
});

test("parseMrz: parses TD1 identity card 3-line format", () => {
  const line1 = "I<UTOD231458907<<<<<<<<<<<<<<<";
  const line2 = "7408122F1204159UTO<<<<<<<<<<<6";
  const line3 = "ERIKSSON<<ANNA<MARIA<<<<<<<<<<";
  const result = parseMrz(`${line1}\n${line2}\n${line3}`);
  assert.ok(result);
  assert.equal(result.format, "TD1");
  assert.equal(result.name, "ANNA MARIA ERIKSSON");
  assert.equal(result.passport_no, "D23145890");
  assert.equal(result.dob, "1974-08-12");
  assert.equal(result.passport_expiry, "2012-04-15");
  assert.equal(result.score, 3);
});

test("parseMrz: returns null for invalid, incomplete, or corrupted text", () => {
  assert.equal(parseMrz(""), null);
  assert.equal(parseMrz("Not an MRZ at all"), null);
  assert.equal(parseMrz("P<UTOERIKSSON<<ANNA\nToo short"), null);
  assert.equal(parseMrz(null), null);
  assert.equal(parseMrz(undefined), null);
});
