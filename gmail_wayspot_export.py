#!/usr/bin/env python3
"""
gmail_wayspot_export.py

Pulls every "Niantic Spatial Wayspot nomination received for ..." email out of
your Gmail account and extracts:
  - portal name
  - submission text   (first text block under "Here's what you've submitted:")
  - supporting text   (second text block)
  - submission photo URL
  - supporting photo URL
  - date received

It also does a second pass for decision emails ("Decision on you Recon
Nomination" / "Niantic Spatial Wayspot nomination decided for") and marks each
matching submission as Accepted or Rejected based on whether the body contains
"congratulations" / "not accept".

Output: wayspot_submissions.json (a list of dicts) in the same folder.
A second file, wayspot_details.js, is also written containing the data
pre-formatted as a JS array literal, ready to paste into the tracker's
GMAIL_DETAILS constant.

---------------------------------------------------------------------------
ONE-TIME SETUP
---------------------------------------------------------------------------
1. pip install --upgrade google-api-python-client google-auth-httplib2 \
       google-auth-oauthlib beautifulsoup4

2. Go to https://console.cloud.google.com/
   - Create a project (or use an existing one)
   - Enable the "Gmail API" (APIs & Services -> Library -> search "Gmail API")
   - Go to APIs & Services -> Credentials -> Create Credentials -> OAuth
     client ID -> Application type: Desktop app
   - Download the JSON file it gives you, rename it to credentials.json,
     and place it in the same folder as this script.

3. Run the script:
       python gmail_wayspot_export.py
   The first run opens a browser window asking you to sign in and approve
   read-only Gmail access. A token.json file is saved afterwards so you
   won't have to log in again next time.

---------------------------------------------------------------------------
"""

import base64
import json
import re
import os.path
from datetime import datetime

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from bs4 import BeautifulSoup

# Read-only scope -- this script can never send, delete, or modify anything.
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

RECEIVED_QUERY = 'subject:"Niantic Spatial Wayspot nomination received for"'
DECIDED_QUERY = (
    'subject:"Decision on you Recon Nomination" '
    'OR subject:"Niantic Spatial Wayspot nomination decided for"'
)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def get_gmail_service():
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                "credentials.json", SCOPES
            )
            creds = flow.run_local_server(port=0)
        with open("token.json", "w") as f:
            f.write(creds.to_json())
    return build("gmail", "v1", credentials=creds)


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------
def list_all_message_ids(service, query):
    """Paginate through search results and return every matching message id."""
    ids = []
    page_token = None
    while True:
        resp = (
            service.users()
            .messages()
            .list(userId="me", q=query, pageToken=page_token, maxResults=500)
            .execute()
        )
        ids.extend(m["id"] for m in resp.get("messages", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return ids


def get_message(service, msg_id):
    return (
        service.users()
        .messages()
        .get(userId="me", id=msg_id, format="full")
        .execute()
    )


def _decode_part(data):
    return base64.urlsafe_b64decode(data.encode("ASCII")).decode("utf-8", errors="replace")


def extract_bodies(payload):
    """Walk the MIME tree and return (plaintext, html) bodies."""
    plaintext, html = "", ""

    def walk(part):
        nonlocal plaintext, html
        mime = part.get("mimeType", "")
        body = part.get("body", {})
        if "data" in body:
            if mime == "text/plain":
                plaintext += _decode_part(body["data"])
            elif mime == "text/html":
                html += _decode_part(body["data"])
        for sub in part.get("parts", []) or []:
            walk(sub)

    walk(payload)
    return plaintext, html


def get_header(payload, name):
    for h in payload.get("headers", []):
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
def parse_portal_name(subject):
    m = re.search(r"nomination received for (.+?)!?\s*$", subject, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return subject.strip()


def parse_submission_email(subject, html_body):
    """Extract portal name, submission/supporting text, and photo URLs."""
    soup = BeautifulSoup(html_body, "html.parser")
    portal_name = parse_portal_name(subject)

    def photo_url(alt_text):
        img = soup.find("img", alt=alt_text)
        return img["src"] if img and img.has_attr("src") else None

    submission_photo = photo_url("Submission Photo")
    supporting_photo = photo_url("Supporting Photo")

    # Collect every centered text <div> in the email body, in order.
    text_blocks = []
    for div in soup.find_all("div"):
        style = div.get("style", "")
        if "text-align: center" not in style and "text-align:center" not in style:
            continue
        # Only want leaf-ish divs (skip ones that just wrap other divs)
        text = div.find(text=True, recursive=False)
        text = div.get_text(strip=True)
        if text:
            text_blocks.append(text)

    # Find where the portal name appears; everything after it (up to the
    # "Recon Criteria" paragraph) is submission/supporting text.
    submission_text, supporting_text, extra_text = "", "", []
    try:
        idx = text_blocks.index(portal_name)
        remaining = text_blocks[idx + 1:]
        # Stop once we hit the boilerplate paragraph
        cleaned = []
        for t in remaining:
            if t.startswith("Your nomination will be reviewed") or "Recon Criteria" in t:
                break
            cleaned.append(t)
        if len(cleaned) > 0:
            submission_text = cleaned[0]
        if len(cleaned) > 1:
            supporting_text = cleaned[1]
        if len(cleaned) > 2:
            extra_text = cleaned[2:]
    except ValueError:
        pass

    return {
        "portal": portal_name,
        "submission_text": submission_text,
        "supporting_text": supporting_text,
        "extra_text": extra_text,
        "submission_photo_url": submission_photo,
        "supporting_photo_url": supporting_photo,
    }


def parse_decision_email(subject, plaintext_body, html_body):
    """Return ('Accepted'|'Rejected'|None, portal_name)."""
    text = (plaintext_body + " " + html_body).lower()
    status = None
    if "congratulations" in text and "accept" in text:
        status = "Accepted"
    elif "not accept" in text or "unfortunately" in text:
        status = "Rejected"

    # Portal name: try both known subject patterns
    m = re.search(r"nomination decided for (.+?)!?\s*$", subject, re.IGNORECASE)
    if m:
        return status, m.group(1).strip()

    # "Decision on you Recon Nomination" doesn't include the name in the
    # subject -- pull it from the body instead (it's usually the first
    # bolded/centered line referencing the nominated title).
    soup = BeautifulSoup(html_body, "html.parser")
    candidates = [
        d.get_text(strip=True)
        for d in soup.find_all("div")
        if "text-align: center" in d.get("style", "") and d.get_text(strip=True)
    ]
    portal_guess = None
    for c in candidates:
        if 3 < len(c) < 80 and "Recon" not in c and "Dear" not in c:
            portal_guess = c
            break
    return status, portal_guess


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    service = get_gmail_service()

    print("Searching for 'nomination received' emails...")
    received_ids = list_all_message_ids(service, RECEIVED_QUERY)
    print(f"  found {len(received_ids)} messages")

    submissions = {}
    for i, msg_id in enumerate(received_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        date_header = get_header(payload, "Date")
        plaintext, html = extract_bodies(payload)

        parsed = parse_submission_email(subject, html)
        try:
            date_iso = datetime.strptime(
                date_header[:25].strip(), "%a, %d %b %Y %H:%M:%S"
            ).strftime("%Y-%m-%d")
        except ValueError:
            date_iso = ""

        key = (parsed["portal"], date_iso)
        submissions[key] = {
            **parsed,
            "submitted_date": date_iso,
            "status": "Pending",
        }
        print(f"  [{i}/{len(received_ids)}] {parsed['portal']}")

    print("\nSearching for decision emails...")
    decided_ids = list_all_message_ids(service, DECIDED_QUERY)
    print(f"  found {len(decided_ids)} messages")

    for i, msg_id in enumerate(decided_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        plaintext, html = extract_bodies(payload)
        status, portal_guess = parse_decision_email(subject, plaintext, html)
        if not status or not portal_guess:
            continue
        # Match by portal name (date-agnostic, since decision emails don't
        # always restate the original submission date)
        for key, sub in submissions.items():
            if sub["portal"].lower() == portal_guess.lower() and sub["status"] == "Pending":
                sub["status"] = status
                break
        print(f"  [{i}/{len(decided_ids)}] {portal_guess} -> {status}")

    results = list(submissions.values())
    results.sort(key=lambda r: r["submitted_date"], reverse=True)

    with open("wayspot_submissions.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nWrote {len(results)} submissions to wayspot_submissions.json")

    # Also emit a ready-to-paste JS array for the tracker's GMAIL_DETAILS constant
    with open("wayspot_details.js", "w", encoding="utf-8") as f:
        f.write("const GMAIL_DETAILS = [\n")
        f.write("  // [portal, submittedDate, submissionText, supportingText, submissionPhotoUrl, supportingPhotoUrl]\n")
        for r in results:
            def esc(s):
                return (s or "").replace("\\", "\\\\").replace('"', '\\"')
            f.write(
                '  ["%s", "%s", "%s", "%s", "%s", "%s"],\n'
                % (
                    esc(r["portal"]),
                    r["submitted_date"],
                    esc(r["submission_text"]),
                    esc(r["supporting_text"]),
                    r["submission_photo_url"] or "",
                    r["supporting_photo_url"] or "",
                )
            )
        f.write("];\n")
    print("Wrote wayspot_details.js (paste straight into the tracker's GMAIL_DETAILS constant)")


if __name__ == "__main__":
    main()
