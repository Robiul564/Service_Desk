import test from "node:test";
import assert from "node:assert/strict";
import { checkDigit, parseMrz } from "../mrz.mjs";

test("parses ICAO TD3 sample with all required check digits valid", () => {
  const mrz = [
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
    "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
  ].join("\n");
  const result = parseMrz(mrz);
  assert.ok(result);
  assert.equal(result.name, "ANNA MARIA ERIKSSON");
  assert.equal(result.passport_no, "L898902C3");
  assert.deepEqual(result.checks, { passport: true, dob: true, expiry: true });
  assert.equal(result.score, 3);
});

test("parses a Bangladeshi BGD TD3 MRZ", () => {
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
  assert.deepEqual(result.checks, { passport: true, dob: true, expiry: true });
});
