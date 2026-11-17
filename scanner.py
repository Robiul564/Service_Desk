#!/usr/bin/env python3
"""
ICAO Doc 9303 Passport & ID Card MRZ Scanner
Supports TD3 (passports: 2x44), TD2 (ID cards: 2x36), and TD1 (ID cards: 3x30).
"""

import sys
import json
import re
from collections import Counter
from datetime import date
import os

import cv2
import numpy as np

try:
    import pytesseract
except ImportError:
    pytesseract = None

# Windows fallback path if Tesseract is installed in default Program Files
if pytesseract is not None and sys.platform == "win32":
    tess_paths = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.expanduser(r"~\AppData\Local\Programs\Tesseract-OCR\tesseract.exe")
    ]
    for p in tess_paths:
        if os.path.exists(p):
            pytesseract.pytesseract.tesseract_cmd = p
            break

OCR_CONFIG = (
    "--psm 6 --oem 1 "
    "-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
)

# ----------------------------------------------------------------------
# ICAO 9303 helpers
# ----------------------------------------------------------------------
WEIGHTS = (7, 3, 1)


def char_value(c):
    if c.isdigit():
        return int(c)
    if "A" <= c <= "Z":
        return ord(c) - 55
    return 0  # '<'


def check_digit(data):
    return str(sum(char_value(c) * WEIGHTS[i % 3] for i, c in enumerate(data)) % 10)


def valid(data, digit):
    return digit.isdigit() and check_digit(data) == digit


TO_DIGIT = str.maketrans(
    {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2",
     "S": "5", "B": "8", "G": "6"})
TO_ALPHA = str.maketrans(
    {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G"})


def num(s):
    return s.translate(TO_DIGIT)


def alpha(s):
    return s.translate(TO_ALPHA)


def parse_date(yymmdd, is_birth):
    if not re.fullmatch(r"\d{6}", yymmdd):
        return None
    yy, mm, dd = int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:])
    if not (1 <= mm <= 12 and 1 <= dd <= 31):
        return None
    if is_birth:
        century = 1900 if yy > date.today().year % 100 else 2000
    else:
        century = 2000
    return f"{century + yy:04d}-{mm:02d}-{dd:02d}"


def parse_names(field):
    parts = field.strip("<").split("<<")
    surname = parts[0].replace("<", " ").strip()
    given = " ".join(p.replace("<", " ").strip() for p in parts[1:]).strip()
    return surname, given


# ----------------------------------------------------------------------
# MRZ parsers (return dict or None if any checksum fails)
# ----------------------------------------------------------------------
def parse_td3(l1, l2):
    if len(l1) != 44 or len(l2) != 44 or l1[0] != "P":
        return None
    doc, doc_cd = l2[0:9], num(l2[9])
    dob, dob_cd = num(l2[13:19]), num(l2[19])
    exp, exp_cd = num(l2[21:27]), num(l2[27])
    pers, pers_cd = l2[28:42], l2[42]
    comp_cd = num(l2[43])
    # composite uses the corrected digits
    composite = doc + doc_cd + dob + dob_cd + exp + exp_cd + pers + pers_cd

    checks = {
        "document_number": valid(doc, doc_cd),
        "birth_date": valid(dob, dob_cd),
        "expiry_date": valid(exp, exp_cd),
        "composite": valid(composite, comp_cd),
    }
    # personal number check may be '<' when the field is empty
    if pers.strip("<") == "":
        checks["personal_number"] = pers_cd in ("<", "0")
    else:
        checks["personal_number"] = valid(pers, pers_cd)

    surname, given = parse_names(l1[5:])
    return _result("TD3", l1[1].replace("<", ""), alpha(l1[2:5]), surname, given,
                   doc, alpha(l2[10:13]), dob, l2[20],
                   exp, pers.strip("<"), checks)


def parse_td2(l1, l2):
    if len(l1) != 36 or len(l2) != 36 or l1[0] not in "ACI":
        return None
    doc, doc_cd = l2[0:9], num(l2[9])
    dob, dob_cd = num(l2[13:19]), num(l2[19])
    exp, exp_cd = num(l2[21:27]), num(l2[27])
    opt = l2[28:35]
    comp_cd = num(l2[35])
    composite = doc + doc_cd + dob + dob_cd + exp + exp_cd + opt
    checks = {
        "document_number": valid(doc, doc_cd),
        "birth_date": valid(dob, dob_cd),
        "expiry_date": valid(exp, exp_cd),
        "composite": valid(composite, comp_cd),
    }
    surname, given = parse_names(l1[5:])
    return _result("TD2", l1[0:2].replace("<", ""), alpha(l1[2:5]), surname, given,
                   doc, alpha(l2[10:13]), dob, l2[20], exp, opt.strip("<"), checks)


def parse_td1(l1, l2, l3):
    if len(l1) != 30 or len(l2) != 30 or len(l3) != 30:
        return None
    doc, doc_cd = l1[5:14], num(l1[14])
    dob, dob_cd = num(l2[0:6]), num(l2[6])
    exp, exp_cd = num(l2[8:14]), num(l2[14])
    comp_cd = num(l2[29])
    composite = l1[5:30] + dob + dob_cd + exp + exp_cd + l2[18:29]
    checks = {
        "document_number": valid(doc, doc_cd),
        "birth_date": valid(dob, dob_cd),
        "expiry_date": valid(exp, exp_cd),
        "composite": valid(composite, comp_cd),
    }
    surname, given = parse_names(l3)
    return _result("TD1", l1[0:2].replace("<", ""), alpha(l1[2:5]), surname, given,
                   doc, alpha(l2[15:18]), dob, l2[7], exp, "", checks)


def _result(fmt, dtype, country, surname, given, doc, nat, dob, sex, exp, opt, checks):
    return {
        "format": fmt,
        "document_type": dtype,
        "issuing_country": country,
        "surname": surname,
        "given_names": given,
        "document_number": doc.replace("<", ""),
        "nationality": nat,
        "birth_date": parse_date(dob, True),
        "sex": sex if sex in "MF" else "X",
        "expiry_date": parse_date(exp, False),
        "optional_data": opt,
        "checks": checks,
        "all_checks_passed": all(checks.values()),
    }


# ----------------------------------------------------------------------
# Image processing / OCR
# ----------------------------------------------------------------------
def find_mrz_region(img):
    """Locate the MRZ band with morphology; fall back to the bottom third."""
    h, w = img.shape[:2]
    scale = 600.0 / w
    small = cv2.resize(img, None, fx=scale, fy=scale)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    rect = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 7))
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, rect)
    grad = cv2.Sobel(blackhat, cv2.CV_32F, 1, 0, ksize=-1)
    grad = np.absolute(grad)
    grad = (255 * (grad - grad.min()) / (grad.max() - grad.min() + 1e-6)).astype("uint8")
    grad = cv2.morphologyEx(grad, cv2.MORPH_CLOSE, rect)
    thresh = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    sq = cv2.getStructuringElement(cv2.MORPH_RECT, (21, 21))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, sq)
    thresh = cv2.erode(thresh, None, iterations=4)

    cnts, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:5]:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw / float(small.shape[1]) > 0.7 and cw / float(ch) > 4:
            best = (x, y, cw, ch)
            break
    if best:
        x, y, cw, ch = best
        pad = int(0.04 * small.shape[0])
        x0 = max(0, int((x - pad) / scale))
        y0 = max(0, int((y - pad) / scale))
        x1 = min(w, int((x + cw + pad) / scale))
        y1 = min(h, int((y + ch + pad) / scale))
        return img[y0:y1, x0:x1]
    return img[int(h * 0.62):, :]


def preprocess(roi, variant):
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    target_w = 1400
    s = target_w / gray.shape[1]
    gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    if variant == 0:
        return cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    if variant == 1:
        return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv2.THRESH_BINARY, 41, 15)
    return gray


def clean_lines(text):
    lines = []
    for raw in text.splitlines():
        s = re.sub(r"[^A-Z0-9<]", "", raw.upper().replace(" ", ""))
        if len(s) >= 26:
            lines.append(s)
    return lines


def fit(line, n):
    """Pad/trim lines that are off by 1-2 chars (OCR often drops trailing '<')."""
    if abs(len(line) - n) > 2:
        return None
    return (line + "<" * n)[:n]


def try_parse(lines):
    for n_lines, size, fn in ((3, 30, parse_td1), (2, 44, parse_td3), (2, 36, parse_td2)):
        if len(lines) < n_lines:
            continue
        for i in range(len(lines) - n_lines + 1):
            fitted = [fit(l, size) for l in lines[i:i + n_lines]]
            if None in fitted:
                continue
            res = fn(*fitted)
            if res and res["all_checks_passed"]:
                return res
    return None


def scan_image(img):
    if pytesseract is None:
        raise RuntimeError("pytesseract is not installed. Run 'pip install pytesseract' to enable OCR.")
    roi = find_mrz_region(img)
    for variant in (0, 1, 2):  # fast first, more robust after
        txt = pytesseract.image_to_string(preprocess(roi, variant), config=OCR_CONFIG)
        res = try_parse(clean_lines(txt))
        if res:
            return res
    return None


# ----------------------------------------------------------------------
# Entry points
# ----------------------------------------------------------------------
def live_scan(camera=0, confirmations=2):
    cap = cv2.VideoCapture(camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    seen = Counter()
    frame_i = 0
    print("Hold the passport photo page flat, MRZ at the bottom. Press Q to quit.")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame_i += 1
        cv2.imshow("MRZ scanner (Q to quit)", cv2.resize(frame, None, fx=0.5, fy=0.5))
        if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
            break
        if frame_i % 3:          # OCR every 3rd frame to stay fast
            continue
        res = scan_image(frame)
        if res:
            key = (res["document_number"], res["birth_date"], res["expiry_date"])
            seen[key] += 1
            if seen[key] >= confirmations:
                cap.release()
                cv2.destroyAllWindows()
                return res
    cap.release()
    cv2.destroyAllWindows()
    return None


if __name__ == "__main__":
    if len(sys.argv) > 1:
        image = cv2.imread(sys.argv[1])
        if image is None:
            sys.exit(f"Cannot read image: {sys.argv[1]}")
        result = scan_image(image)
    else:
        result = live_scan()

    if result:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print("No valid MRZ found. Improve lighting, avoid glare, keep the MRZ sharp.")
