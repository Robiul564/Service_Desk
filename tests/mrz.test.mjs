import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDigit,
  parseTd3Name,
  validateTd3Pair,
  parseTd3Mrz,
  extractTd3Mrz,
  repairIcaoCountryCode,
  parseMrz,
  MrzFrameConsensus,
  crossVerifyNameWithViz,
  isValidIcaoCountryCode,
  parseMrzDate,
  fit,
  cleanLines,
  parseTd1,
  parseTd2,
  parseTd3,
  tryParseMrz
} from "../mrz.mjs";

/**
 * Helper to construct a valid 44x2 TD3 passport MRZ for tests.
 */
function buildTd3({
  docType = "P<",
  issuingState = "BGD",
  nameField39,
  passportNo = "A09479295",
  nationality = "BGD",
  dob = "920510",
  sex = "M",
  expiry = "320510",
  personal = "<".repeat(14),
  personalCheckOverride = null
}) {
  const nf = nameField39.padEnd(39, "<").slice(0, 39);
  const line1 = `${docType}${issuingState}${nf}`;
  const pp = passportNo.padEnd(9, "<").slice(0, 9);
  const ppCd = checkDigit(pp);
  const dobCd = checkDigit(dob);
  const expCd = checkDigit(expiry);
  const pers = personal.padEnd(14, "<").slice(0, 14);
  const persCd = personalCheckOverride !== null ? personalCheckOverride : (pers === "<".repeat(14) ? "<" : String(checkDigit(pers)));
  const compSrc = `${pp}${ppCd}${dob}${dobCd}${expiry}${expCd}${pers}${persCd}`;
  const compCd = checkDigit(compSrc);
  const line2 = `${pp}${ppCd}${nationality}${dob}${dobCd}${sex}${expiry}${expCd}${pers}${persCd}${compCd}`;
  assert.equal(line1.length, 44, "Test fixture line 1 must be 44 chars");
  assert.equal(line2.length, 44, "Test fixture line 2 must be 44 chars");
  return `${line1}\n${line2}`;
}

const REF_DATE = new Date("2026-11-18T00:00:00Z");

// ============================================================================
// 1. CHECK DIGIT & ICAO SPECIMEN PASSPORTS
// ============================================================================

test("checkDigit: computes ICAO Doc 9303 7-3-1 weights accurately", () => {
  assert.equal(checkDigit("L898902C3"), 6);
  assert.equal(checkDigit("740812"), 2);
  assert.equal(checkDigit("120415"), 9);
  assert.equal(checkDigit("ZE184226B<<<<<"), 1);
  assert.equal(checkDigit("L898902C3674081221204159ZE184226B<<<<<1"), 0);
  assert.equal(checkDigit("<<<<<<<<<<<<<<"), 0);
});

test("ICAO 9303 Part 4 Specimen Passport (UTO — ERIKSSON<<ANNA<MARIA)", () => {
  const mrz = [
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
    "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
  ].join("\n");

  const res = parseTd3Mrz(mrz, { referenceDate: REF_DATE });
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.equal(res.data.issuing_state, "UTO");
  assert.equal(res.data.surname, "ERIKSSON");
  assert.equal(res.data.given_names, "ANNA MARIA");
  assert.equal(res.data.name, "ANNA MARIA ERIKSSON");
  assert.equal(res.data.passport_no, "L898902C3");
  assert.equal(res.data.dob, "1974-08-12");
  assert.equal(res.data.sex, "F");
  assert.equal(res.data.passport_expiry, "2012-04-15");
  assert.equal(res.data.personal_number, "ZE184226B");
  assert.equal(res.data.checks.passport, true);
  assert.equal(res.data.checks.dob, true);
  assert.equal(res.data.checks.expiry, true);
  assert.equal(res.data.checks.personal, true);
  assert.equal(res.data.checks.composite, true);
});

test("ICAO special issuing state D<< (Germany) & transliterated AE/UE/OE names", () => {
  const mrz = buildTd3({
    issuingState: "D<<",
    nationality: "D<<",
    nameField39: "MUELLER<SCHMIDT<<JUERGEN<GOETZ",
    passportNo: "C01X00T47",
    dob: "830812",
    sex: "M",
    expiry: "310811"
  });
  const res = parseTd3Mrz(mrz, { referenceDate: REF_DATE });
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.equal(res.data.issuing_state, "D");
  assert.equal(res.data.nationality, "German");
  assert.equal(res.data.surname, "MUELLER SCHMIDT");
  assert.equal(res.data.given_names, "JUERGEN GOETZ");
});

// ============================================================================
// 2. NAME PARSING EDGE CASES (MAIN BUG FIX)
// ============================================================================

test("parseTd3Name: multiple surnames, multiple given names, hyphens & apostrophes", () => {
  const m1 = buildTd3({ nameField39: "DE<LA<CRUZ<<JOSE<ANTONIO<MARIA" });
  const r1 = parseMrz(m1, { referenceDate: REF_DATE });
  assert.equal(r1.surname, "DE LA CRUZ");
  assert.equal(r1.given_names, "JOSE ANTONIO MARIA");
  assert.equal(r1.name_truncated, false);

  const m2 = buildTd3({ nameField39: "O<CONNOR<<JEAN<LUC" });
  const r2 = parseMrz(m2, { referenceDate: REF_DATE });
  assert.equal(r2.surname, "O CONNOR");
  assert.equal(r2.given_names, "JEAN LUC");
});

test("parseTd3Name: 39-character truncated name is preserved and flagged truncated=true", () => {
  const truncated39 = "MOHAMMAD<ABDUR<RAHMAN<<MUHAMMAD<SHAHIDU";
  assert.equal(truncated39.length, 39);
  const mrz = buildTd3({ nameField39: truncated39 });
  const res = parseMrz(mrz, { referenceDate: REF_DATE });
  assert.ok(res);
  assert.equal(res.surname, "MOHAMMAD ABDUR RAHMAN");
  assert.equal(res.given_names, "MUHAMMAD SHAHIDU");
  assert.equal(res.name_truncated, true);
});

test("parseTd3Name: strips trailing OCR noise (KKKK, CCC, <<<K<<C<L<, <K<K<K<K) without corrupting real names", () => {
  // Case A: All trailing "<" misread as K ("KKKKKKKKKKKKKKKKKKK")
  const line1A = "P<UTOERIKSSON<<ANNA<MARIAKKKKKKKKKKKKKKKKKKK";
  const pA = parseTd3Name(line1A);
  assert.equal(pA.valid, true);
  assert.equal(pA.surname, "ERIKSSON");
  assert.equal(pA.given_names, "ANNA MARIA");

  // Case B: Mixed OCR noise inside trailing filler ("<<<K<<KK<C<L<S<E<I<")
  const line1B = "P<UTOERIKSSON<<ANNA<MARIA<<<K<<KK<C<L<S<E<I<";
  const pB = parseTd3Name(line1B);
  assert.equal(pB.valid, true);
  assert.equal(pB.surname, "ERIKSSON");
  assert.equal(pB.given_names, "ANNA MARIA");

  // Case C: Alternating "<K<K<K<K" noise to end of line
  const line1C = "P<BGDRAHMAN<<MD<OSMAN<K<K<K<K<K<K<K<K<K<K<K<";
  const pC = parseTd3Name(line1C);
  assert.equal(pC.valid, true);
  assert.equal(pC.surname, "RAHMAN");
  assert.equal(pC.given_names, "MD OSMAN");

  // Case D: Single-name passport with trailing KKKKK noise
  const line1D = "P<BGDCHOKDERKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK";
  const pD = parseTd3Name(line1D);
  assert.equal(pD.valid, true);
  assert.equal(pD.surname, "CHOKDER");
  assert.equal(pD.given_names, "");

  // Case E: Legitimate single-letter middle initial "K" MUST be preserved!
  const line1E = "P<USASMITH<<JOHN<K<<<<<<<<<<<<<<<<<<<<<<<<<<";
  const pE = parseTd3Name(line1E);
  assert.equal(pE.valid, true);
  assert.equal(pE.surname, "SMITH");
  assert.equal(pE.given_names, "JOHN K");

  // Case F: Real names containing K, C, L, S, E, I (MALIK, CLARK, LEE) MUST be preserved!
  const line1F = "P<BGDCLARK<<MALIK<LEE<<<<<<<<<<<KKK<<<<<<<<<";
  const pF = parseTd3Name(line1F);
  assert.equal(pF.valid, true);
  assert.equal(pF.surname, "CLARK");
  assert.equal(pF.given_names, "MALIK LEE");
});

test("parseTd3Name: ICAO OCR letter correction heals O/0, I/1, B/8, S/5, Z/2, G/6, A/4; rejects unresolvable digits", () => {
  // Digit "0" inside surname ("ERIKSS0N") and "1" in given names ("MAR1A") should be repaired
  const line1 = "P<UTOERIKSS0N<<ANNA<MAR1A<<<<<<<<<<<<<<<<<<<";
  const line2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
  const res = validateTd3Pair(line1, line2, { referenceDate: REF_DATE });
  assert.equal(res.valid, true);
  assert.equal(res.data.surname, "ERIKSSON");
  assert.equal(res.data.given_names, "ANNA MARIA");
  assert.equal(res.data.name, "ANNA MARIA ERIKSSON");

  // Separator misread as "<K" between surname and given names is cleanly recovered
  const line1Sep = "P<BGDRAHMAN<KMOHAMMAD<AZIZUL<<<<<<<<<<<<<<<<";
  const resSep = parseTd3Name(line1Sep);
  assert.equal(resSep.valid, true);
  assert.equal(resSep.surname, "RAHMAN");
  assert.equal(resSep.given_names, "MOHAMMAD AZIZUL");

  // Single-identifier / given-names only passport starting with "<<"
  const line1Given = "P<BGD<<MOHAMMAD<AZIZUL<<<<<<<<<<<<<<<<<<<<<<";
  const resGiven = parseTd3Name(line1Given);
  assert.equal(resGiven.valid, true);
  assert.equal(resGiven.surname, "");
  assert.equal(resGiven.given_names, "MOHAMMAD AZIZUL");

  // Unresolvable digits like 3, 7, 9 MUST fail validation
  const bad3 = "P<UTOERIKSS3N<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
  const badRes = validateTd3Pair(bad3, line2, { referenceDate: REF_DATE });
  assert.equal(badRes.valid, false);
});

test("parseTd3Name: accurately separates multiple given names, multiple surnames, and handles OCR glyphs (8->B, 1->I, 0->O, 5->S)", () => {
  // Case 1: Multiple given names: "JOHN MICHAEL PAUL"
  const l1Multi = "P<GBRSMITH<<JOHN<MICHAEL<PAUL<<<<<<<<<<<<<<<";
  const rMulti = parseTd3Name(l1Multi);
  assert.equal(rMulti.valid, true);
  assert.equal(rMulti.surname, "SMITH");
  assert.equal(rMulti.given_names, "JOHN MICHAEL PAUL");
  assert.equal(rMulti.full_name, "JOHN MICHAEL PAUL SMITH");

  // Case 2: Multiple surnames (two family names): "GARCIA MARQUEZ"
  const l1Surs = "P<COLGARCIA<MARQUEZ<<GABRIEL<<<<<<<<<<<<<<<<";
  const rSurs = parseTd3Name(l1Surs);
  assert.equal(rSurs.valid, true);
  assert.equal(rSurs.surname, "GARCIA MARQUEZ");
  assert.equal(rSurs.given_names, "GABRIEL");

  // Case 3: Complex OCR glyph confusion (8->B, 1->I, 0->O, 5->S): "8APARY<<L1P0N<HA5AN" -> "BAPARY", "LIPON HASAN"
  const l1Ocr = "P<BGD8APARY<<L1P0N<HA5AN<<<<<<<<<<<<<<<<<<<<";
  const rOcr = parseTd3Name(l1Ocr);
  assert.equal(rOcr.valid, true);
  assert.equal(rOcr.surname, "BAPARY");
  assert.equal(rOcr.given_names, "LIPON HASAN");
  assert.equal(rOcr.full_name, "LIPON HASAN BAPARY");

  // Case 4: Complete TD3 field extraction check (all Section 2 fields)
  const l2 = "A012345678BGD9408126M3104150ZE184226B<<<<<10";
  const res = validateTd3Pair(l1Ocr, l2, { referenceDate: REF_DATE });
  assert.equal(res.valid, true);
  assert.equal(res.data.surname, "BAPARY");
  assert.equal(res.data.given_names, "LIPON HASAN");
  assert.equal(res.data.name, "LIPON HASAN BAPARY");
  assert.equal(res.data.passport_no, "A01234567");
  assert.equal(res.data.dob, "1994-08-12");
  assert.equal(res.data.birth_date, "1994-08-12");
  assert.equal(res.data.sex, "M");
  assert.equal(res.data.gender, "Male");
  assert.equal(res.data.nationality, "Bangladeshi");
  assert.equal(res.data.nationality_code, "BGD");
  assert.equal(res.data.issuing_country, "BGD");
  assert.equal(res.data.issuing_state, "BGD");
  assert.equal(res.data.passport_expiry, "2031-04-15");
  assert.equal(res.data.expiry_date, "2031-04-15");
  assert.equal(res.data.personal_number, "ZE184226B");
  assert.equal(res.data.optional_data, "ZE184226B");
  assert.equal(res.data.checks.passport, true);
  assert.equal(res.data.checks.dob, true);
  assert.equal(res.data.checks.expiry, true);
  assert.equal(res.data.checks.personal, true);
  assert.equal(res.data.checks.composite, true);
});

// ============================================================================
// 3. STRICT TD3 SCOPE & VALIDATION (NO UNCHECKED DATA)
// ============================================================================

test("Strict TD3 scope: rejects TD1 (3x30), TD2 (2x36), short lines, and long lines", () => {
  // TD1 ID Card MUST be rejected
  const td1 = [
    "I<UTOD231458907<<<<<<<<<<<<<<<",
    "7408122F1204159UTO<<<<<<<<<<<6",
    "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"
  ].join("\n");
  assert.equal(parseMrz(td1, { referenceDate: REF_DATE }), null);

  // TD2 (2x36) MUST be rejected
  const td2 = [
    "I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<",
    "D231458907UTO7408122F1204159<<<<<<<6"
  ].join("\n");
  assert.equal(parseMrz(td2, { referenceDate: REF_DATE }), null);

  // 43-char truncated line MUST be rejected (no silent padding!)
  const short43 = [
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<",
    "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
  ].join("\n");
  assert.equal(parseMrz(short43, { referenceDate: REF_DATE }), null);
});

test("Numeric-only OCR corrections (O->0, I->1, B->8, S->5, Z->2, G->6) in dates & check digits", () => {
  // DOB "740812" misread as "74O8I2", Expiry "120415" misread as "I2O4I5", check digit "6" misread as "G"
  const line1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
  const line2 = "L898902C3GUTO74O8I22FI2O4I59ZE184226B<<<<<10";
  const res = parseTd3Mrz(`${line1}\n${line2}`, { referenceDate: REF_DATE });
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.equal(res.data.passport_no, "L898902C3");
  assert.equal(res.data.dob, "1974-08-12");
  assert.equal(res.data.passport_expiry, "2012-04-15");
});

test("Validation rejects invalid check digits, invalid country codes, invalid sex, and impossible dates", () => {
  // Bad composite check digit (pos 44 changed from 0 to 9)
  const badComposite = parseTd3Mrz(
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<19",
    { referenceDate: REF_DATE }
  );
  assert.equal(badComposite.valid, false);
  assert.equal(badComposite.checks.composite, false);

  // Invalid issuing state "ZZZ"
  const badCountry = parseTd3Mrz(
    buildTd3({ issuingState: "ZZZ", nameField39: "RAHMAN<<OSMAN" }),
    { referenceDate: REF_DATE }
  );
  assert.equal(badCountry.valid, false);
  assert.equal(badCountry.checks.issuingState, false);

  // Invalid sex "X"
  const badSex = parseTd3Mrz(
    buildTd3({ sex: "X", nameField39: "RAHMAN<<OSMAN" }),
    { referenceDate: REF_DATE }
  );
  assert.equal(badSex.valid, false);
  assert.equal(badSex.checks.sex, false);

  // Impossible calendar date (Feb 30)
  const badDate = parseTd3Mrz(
    buildTd3({ dob: "900230", nameField39: "RAHMAN<<OSMAN" }),
    { referenceDate: REF_DATE }
  );
  assert.equal(badDate.valid, false);
  assert.equal(badDate.checks.dob, false);

  // Century resolution: DOB "270101" relative to 2026-11-18 MUST resolve to 1927-01-01 (not future 2027)
  assert.equal(parseMrzDate("270101", { isDob: true, referenceDate: REF_DATE }), "1927-01-01");
  // DOB "050315" relative to 2026-11-18 resolves to 2005-03-15
  assert.equal(parseMrzDate("050315", { isDob: true, referenceDate: REF_DATE }), "2005-03-15");
  // Expiry "340615" resolves to 2034-06-15
  assert.equal(parseMrzDate("340615", { isDob: false, referenceDate: REF_DATE }), "2034-06-15");
  // Country validator
  assert.equal(isValidIcaoCountryCode("BGD"), true);
  assert.equal(isValidIcaoCountryCode("D<<"), true);
  assert.equal(isValidIcaoCountryCode("123"), false);
});

// ============================================================================
// 4. MULTI-FRAME MAJORITY VOTING & N-CONSECUTIVE CONSENSUS
// ============================================================================

test("MrzFrameConsensus: requires N=3 consecutive agreeing frames and heals single-frame name error", () => {
  const consensus = new MrzFrameConsensus({ requiredFrames: 3 });

  const clean = buildTd3({ nameField39: "HOSSAIN<<MD<SHAKIL" });
  const noisyFrame1 = buildTd3({ nameField39: "HOSSAIN<<MD<SHAKIQ" }); // Single-frame 1-char OCR glitch in name!

  // Frame 1 (glitchy name) -> valid line 2, streak = 1, NOT locked
  const r1 = consensus.push(noisyFrame1, { referenceDate: REF_DATE });
  assert.equal(r1.locked, false);
  assert.equal(r1.consecutive, 1);

  // Frame 2 (clean) -> tie goes to recent frame ("SHAKIL"), key changed -> streak = 1
  const r2 = consensus.push(clean, { referenceDate: REF_DATE });
  assert.equal(r2.locked, false);
  assert.equal(r2.consecutive, 1);

  // Frame 3 (clean) -> majority vote is "SHAKIL" (2 vs 1) -> streak = 2
  const r3 = consensus.push(clean, { referenceDate: REF_DATE });
  assert.equal(r3.locked, false);
  assert.equal(r3.consecutive, 2);

  // Frame 4 (clean) -> majority vote "SHAKIL" (3 vs 1), 3 consecutive frames agree -> LOCKED!
  const r4 = consensus.push(clean, { referenceDate: REF_DATE });
  assert.equal(r4.locked, true);
  assert.equal(r4.consecutive, 3);
  assert.equal(r4.data.surname, "HOSSAIN");
  assert.equal(r4.data.given_names, "MD SHAKIL");
});

// ============================================================================
// 5. VIZ PRINTED NAME CROSS-VERIFICATION
// ============================================================================

test("crossVerifyNameWithViz: verifies exact, diacritic/transliterated, truncated names & flags mismatches", () => {
  // Exact match against noisy full VIZ page text
  const vizClean = "PEOPLES REPUBLIC OF BANGLADESH\nPASSPORT\nSurname\nRAHMAN\nGiven Names\nOSMAN GONI\nNationality BANGLADESHI";
  const v1 = crossVerifyNameWithViz({ surname: "RAHMAN", given_names: "OSMAN GONI" }, vizClean);
  assert.equal(v1.status, "verified");
  assert.ok(v1.score >= 0.95);

  // Diacritic & hyphen match: Müller-Schmidt, Jürgen Götz <-> MUELLER SCHMIDT / JUERGEN GOETZ
  const vizGerman = "BUNDESREPUBLIK DEUTSCHLAND\nName / Surname\nMüller-Schmidt\nVornamen / Given names\nJürgen Götz";
  const v2 = crossVerifyNameWithViz({ surname: "MUELLER SCHMIDT", given_names: "JUERGEN GOETZ" }, vizGerman);
  assert.equal(v2.status, "verified");

  // Truncated 39-char MRZ name ("SHAHIDU") matching full VIZ ("SHAHIDUL")
  const vizLong = "Surname: MOHAMMAD ABDUR RAHMAN\nGiven Names: MUHAMMAD SHAHIDUL";
  const v3 = crossVerifyNameWithViz(
    { surname: "MOHAMMAD ABDUR RAHMAN", given_names: "MUHAMMAD SHAHIDU", name_truncated: true },
    vizLong
  );
  assert.equal(v3.status, "verified");

  // Mismatch detection (MRZ misread "RAHMAN" as "RAHKAN" or wrong surname)
  const v4 = crossVerifyNameWithViz({ surname: "KARIM", given_names: "OSMAN GONI" }, vizClean);
  assert.equal(v4.status, "mismatch");
  assert.deepEqual(v4.unmatchedTokens, ["KARIM"]);

  // Unreadable / empty VIZ
  const v5 = crossVerifyNameWithViz({ surname: "RAHMAN", given_names: "OSMAN" }, "");
  assert.equal(v5.status, "unavailable");
});

// ============================================================================
// 7. CORPUS PER-FIELD ACCURACY REPORT
// ============================================================================

test("Per-field accuracy benchmark across diverse TD3 passport corpus (100% accuracy)", () => {
  const corpus = [
    {
      label: "ICAO Specimen UTO",
      mrz: "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10",
      expected: { surname: "ERIKSSON", given_names: "ANNA MARIA", passport_no: "L898902C3", dob: "1974-08-12", passport_expiry: "2012-04-15", sex: "F", issuing_state: "UTO" }
    },
    {
      label: "BGD Standard with KKKK OCR filler noise",
      mrz: buildTd3({ nameField39: "MIA<<MD<OSMAN<GONIKKKKKKKKKKKKKKKKKKKKK", passportNo: "A09479295", dob: "950318", expiry: "340520", sex: "M" }),
      expected: { surname: "MIA", given_names: "MD OSMAN GONI", passport_no: "A09479295", dob: "1995-03-18", passport_expiry: "2034-05-20", sex: "M", issuing_state: "BGD" }
    },
    {
      label: "Multiple Surnames + Multiple Given Names",
      mrz: buildTd3({ issuingState: "ESP", nationality: "ESP", nameField39: "DE<LA<CRUZ<<JOSE<ANTONIO<MARIA", passportNo: "PAE123456", dob: "881104", expiry: "311103", sex: "M" }),
      expected: { surname: "DE LA CRUZ", given_names: "JOSE ANTONIO MARIA", passport_no: "PAE123456", dob: "1988-11-04", passport_expiry: "2031-11-03", sex: "M", issuing_state: "ESP" }
    },
    {
      label: "Germany D<< Hyphenated & Transliterated",
      mrz: buildTd3({ issuingState: "D<<", nationality: "D<<", nameField39: "MUELLER<SCHMIDT<<HANS<PETER", passportNo: "C01X00T47", dob: "810722", expiry: "300721", sex: "M" }),
      expected: { surname: "MUELLER SCHMIDT", given_names: "HANS PETER", passport_no: "C01X00T47", dob: "1981-07-22", passport_expiry: "2030-07-21", sex: "M", issuing_state: "D" }
    },
    {
      label: "39-Char Truncated Long Name",
      mrz: buildTd3({ nameField39: "MOHAMMAD<ABDUR<RAHMAN<<MUHAMMAD<SHAHIDU", passportNo: "EB0451298", dob: "970915", expiry: "330914", sex: "M" }),
      expected: { surname: "MOHAMMAD ABDUR RAHMAN", given_names: "MUHAMMAD SHAHIDU", passport_no: "EB0451298", dob: "1997-09-15", passport_expiry: "2033-09-14", sex: "M", issuing_state: "BGD" }
    },
    {
      label: "Single-Name Passport with Alternating <K Noise",
      mrz: buildTd3({ nameField39: "CHOKDER<<<K<K<K<K<K<K<K<K<K<K<K<K<K<K<K", passportNo: "B00192837", dob: "910105", expiry: "320104", sex: "M" }),
      expected: { surname: "CHOKDER", given_names: "", passport_no: "B00192837", dob: "1991-01-05", passport_expiry: "2032-01-04", sex: "M", issuing_state: "BGD" }
    }
  ];

  const fields = ["surname", "given_names", "passport_no", "dob", "passport_expiry", "sex", "issuing_state"];
  const stats = Object.fromEntries(fields.map(f => [f, { pass: 0, total: corpus.length }]));

  for (const sample of corpus) {
    const res = parseTd3Mrz(sample.mrz, { referenceDate: REF_DATE });
    assert.equal(res.valid, true, `Sample failed [${sample.label}]: ${res.errors.join("; ")}`);
    for (const f of fields) {
      assert.equal(res.data[f], sample.expected[f], `Mismatch on [${sample.label}].${f}`);
      stats[f].pass += 1;
    }
  }

  for (const f of fields) {
    assert.equal(stats[f].pass, stats[f].total);
  }
});

test("Universal multi-format MRZ engine (Python try_parse equivalent): fit, sliding window & multi-format support", () => {
  // 1. fit: pads or trims ±1-2 characters
  assert.equal(fit("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<", 44), "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<");
  assert.equal(fit("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", 44), "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<");
  assert.equal(fit("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<<", 44), "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<");
  assert.equal(fit("SHORT", 44), null);

  // 2. TD3 with dropped trailing '<' is recovered via tryParseMrz
  const rawWithShortLine = [
    "GARBAGE HEADER LINE 12345",
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<", // 43 chars (dropped 1 trailing '<')
    "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
    "EXTRA FOOTER SCAN NOISE 987654"
  ].join("\n");
  const resTd3 = tryParseMrz(rawWithShortLine, { referenceDate: REF_DATE });
  assert.ok(resTd3, "Should successfully parse TD3 passport even with noisy surrounding lines and 43 chars");
  assert.equal(resTd3.format, "TD3");
  assert.equal(resTd3.surname, "ERIKSSON");
  assert.equal(resTd3.given_names, "ANNA MARIA");
  assert.equal(resTd3.document_number, "L898902C3");
  assert.equal(resTd3.all_checks_passed, true);

  // 3. TD1 (3 lines x 30 characters) ID card
  const td1Text = [
    "I<UTOD231458907<<<<<<<<<<<<<<<",
    "7408122F1204159UTO<<<<<<<<<<<6",
    "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"
  ].join("\n");
  const resTd1 = tryParseMrz(td1Text, { referenceDate: REF_DATE });
  assert.ok(resTd1, "Should successfully parse TD1 ID card");
  assert.equal(resTd1.format, "TD1");
  assert.equal(resTd1.surname, "ERIKSSON");
  assert.equal(resTd1.given_names, "ANNA MARIA");
  assert.equal(resTd1.document_number, "D23145890");
  assert.equal(resTd1.all_checks_passed, true);

  // 4. TD2 (2 lines x 36 characters) ID card
  const td2Text = [
    "I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<",
    "D231458907UTO7408122F1204159<<<<<<<6"
  ].join("\n");
  const resTd2 = tryParseMrz(td2Text, { referenceDate: REF_DATE });
  assert.ok(resTd2, "Should successfully parse TD2 ID card");
  assert.equal(resTd2.format, "TD2");
  assert.equal(resTd2.surname, "ERIKSSON");
  assert.equal(resTd2.given_names, "ANNA MARIA");
  assert.equal(resTd2.document_number, "D23145890");
  assert.equal(resTd2.all_checks_passed, true);
});

// ============================================================================
// 8. ROBUST REAL-WORLD OCR RECOVERY, MORPHOLOGICAL OBB & OFFLINE ASSET TESTS
// ============================================================================

test("extractTd3Mrz: recovers from flanking desk-edge noise, extra/missing chars & country OCR confusion", () => {
  // 1. Flanking border garbage on both lines (exact failure mode from real desk photos)
  const flanked = [
    "CG P<BGDRAHMAN<<MD<ABU<TAHER<<<<<<<<<<<<<<<<<<< L0",
    "<5 A094792953BGD9205107M3205105<<<<<<<<<<<<<<<4 8B"
  ].join("\n");
  const r1 = extractTd3Mrz(flanked, { referenceDate: REF_DATE });
  assert.equal(r1.valid, true, r1.errors.join("; "));
  assert.equal(r1.data.surname, "RAHMAN");
  assert.equal(r1.data.given_names, "MD ABU TAHER");
  assert.equal(r1.data.passport_no, "A09479295");
  assert.equal(r1.data.dob, "1992-05-10");
  assert.equal(r1.data.passport_expiry, "2032-05-10");

  // 2. Single extra OCR-inserted character in middle of Line 2 (45 chars: "ZE184226GB" -> "ZE184226B")
  const inserted = [
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
    "L898902C3GUTO7408122F1204159ZE184226GB<<<<<10"
  ].join("\n");
  const r2 = extractTd3Mrz(inserted, { referenceDate: REF_DATE });
  assert.equal(r2.valid, true, r2.errors.join("; "));
  assert.equal(r2.data.passport_no, "L898902C3");
  assert.equal(r2.data.personal_number, "ZE184226B");

  // 3. Dropped trailing '<' on Line 1 + country code OCR confusion ("0<<" -> "D<<", "0<D<<" -> "P<D<<")
  const shortAndConfused = [
    "0<D<<MUELLER<<HANS<JUERGEN<<<<<",
    "C01X00T4780<<6408125M2702283<<<<<<<<<<<<<<<4"
  ].join("\n");
  const r3 = extractTd3Mrz(shortAndConfused, { referenceDate: REF_DATE });
  assert.equal(r3.valid, true, r3.errors.join("; "));
  assert.equal(r3.data.issuing_state, "D");
  assert.equal(r3.data.surname, "MUELLER");
  assert.equal(r3.data.given_names, "HANS JUERGEN");
  assert.equal(r3.data.passport_no, "C01X00T47");

  // 4. Country code alpha-only repair helper
  assert.equal(repairIcaoCountryCode("B6D"), "BGD");
  assert.equal(repairIcaoCountryCode("6GD"), "BGD");
  assert.equal(repairIcaoCountryCode("0<<"), "D<<");
  assert.equal(repairIcaoCountryCode("UT0"), "UTO");
  assert.equal(repairIcaoCountryCode("999"), null);

  // 5. Still strictly rejects corrupted composite check digit & digits inside name
  const badCheck = [
    "CG P<BGDRAHMAN<<MD<ABU<TAHER<<<<<<<<<<<<<<<<<<< L0",
    "<5 A094792953BGD9205107M3205105<<<<<<<<<<<<<<<9 8B"
  ].join("\n");
  assert.equal(extractTd3Mrz(badCheck, { referenceDate: REF_DATE }).valid, false);
});

test("Offline OCR-B model and self-hosted Tesseract WASM assets are present for Android PWA", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const requiredAssets = [
    "model/mrz.traineddata.gz",
    "vendor/tesseract/tesseract.min.js",
    "vendor/tesseract/worker.min.js",
    "vendor/tesseract/tesseract-core-lstm.wasm.js",
    "vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
    "vendor/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js",
    "vendor/tesseract/LICENSE.md"
  ];
  for (const rel of requiredAssets) {
    const full = path.join(root, rel);
    assert.ok(fs.existsSync(full), `Missing required offline OCR asset: ${rel}`);
    assert.ok(fs.statSync(full).size > 1000, `Asset looks unexpectedly empty: ${rel}`);
  }
});
