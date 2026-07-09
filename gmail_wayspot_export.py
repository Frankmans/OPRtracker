#!/usr/bin/env python3
"""
gmail_wayspot_export.py

Pulls three kinds of Niantic Wayspot emails out of your Gmail account:

  1. NOMINATIONS  -- new Wayspot candidates you submitted
       "Niantic Spatial Wayspot nomination received for ..."
     decided by:
       "Decision on you Recon Nomination"
       "Niantic Spatial Wayspot nomination decided for ..."

  2. PHOTO SUBMISSIONS -- photos you added to an existing Wayspot
       "Thanks! Niantic Spatial Wayspot Photo received for ..."
     decided by:
       "Niantic Spatial Wayspot media submission decided for ..."

  3. EDIT SUGGESTIONS -- title/description/location edits proposed for an
     existing Wayspot
       "Thanks! Niantic Spatial Wayspot edit suggestion received for ..."
     decided by:
       "Niantic Spatial Wayspot edit suggestion decided for ..."

For nominations, it extracts the portal name, both text blocks ("submission
text" and "supporting text"), and both photo URLs. Photo-submission emails
don't include any of that on Niantic's side -- just the portal name and,
later, the decision -- so those fields are left blank for that type. Edit
suggestions include the existing value and the suggested replacement, tagged
with which field was edited (title/description/location/etc).

Note on edit suggestions: the *subject* of a "decided" email is not a
reliable portal name -- for title edits, Niantic puts the newly-suggested
title there instead of the Wayspot's original name. The email *body*,
however, reliably states the edited field and the original submission date
("...your Wayspot title suggestion for X on Jan 7, 2026..."), so decisions
are matched using the field + date rather than the subject line.

Output: wayspot_submissions.json (a list of dicts) in the same folder, with
each entry tagged "submission_type": "Nomination", "Photo", or "Edit" (edits
also carry an "edit_field": "Title" / "Description" / "Location" / etc).

---------------------------------------------------------------------------
ONE-TIME SETUP
---------------------------------------------------------------------------
1. pip install -r requirements.txt

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

NOMINATION_RECEIVED_QUERY = 'subject:"Niantic Spatial Wayspot nomination received for"'
NOMINATION_DECIDED_QUERY = (
    'subject:"Decision on you Recon Nomination" '
    'OR subject:"Niantic Spatial Wayspot nomination decided for"'
)
PHOTO_RECEIVED_QUERY = 'subject:"Thanks! Niantic Spatial Wayspot Photo received for"'
PHOTO_DECIDED_QUERY = 'subject:"Niantic Spatial Wayspot media submission decided for"'
EDIT_RECEIVED_QUERY = 'subject:"Thanks! Niantic Spatial Wayspot edit suggestion received for"'
EDIT_DECIDED_QUERY = 'subject:"Niantic Spatial Wayspot edit suggestion decided for"'


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


def parse_email_date(date_header):
    try:
        return datetime.strptime(
            date_header[:25].strip(), "%a, %d %b %Y %H:%M:%S"
        ).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def centered_text_blocks(soup):
    """Every centered text <div> in the email body, in order."""
    blocks = []
    for div in soup.find_all("div"):
        style = div.get("style", "")
        if "text-align: center" not in style and "text-align:center" not in style:
            continue
        text = div.get_text(strip=True)
        if text:
            blocks.append(text)
    return blocks


# ---------------------------------------------------------------------------
# Parsing -- Nominations
# ---------------------------------------------------------------------------
def parse_nomination_portal_name(subject):
    m = re.search(r"nomination received for (.+?)!?\s*$", subject, re.IGNORECASE)
    return m.group(1).strip() if m else subject.strip()


def parse_nomination_email(subject, html_body):
    """Extract portal name, submission/supporting text, and photo URLs."""
    soup = BeautifulSoup(html_body, "html.parser")
    portal_name = parse_nomination_portal_name(subject)

    def photo_url(alt_text):
        img = soup.find("img", alt=alt_text)
        return img["src"] if img and img.has_attr("src") else None

    submission_photo = photo_url("Submission Photo")
    supporting_photo = photo_url("Supporting Photo")

    text_blocks = centered_text_blocks(soup)

    submission_text, supporting_text, extra_text = "", "", []
    try:
        idx = text_blocks.index(portal_name)
        remaining = text_blocks[idx + 1:]
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


def parse_nomination_decision(subject, plaintext_body, html_body):
    """Return ('Accepted'|'Rejected'|None, portal_name)."""
    text = (plaintext_body + " " + html_body).lower()
    status = None
    if "congratulations" in text and "accept" in text:
        status = "Accepted"
    elif "not accept" in text or "unfortunately" in text:
        status = "Rejected"

    m = re.search(r"nomination decided for (.+?)!?\s*$", subject, re.IGNORECASE)
    if m:
        return status, m.group(1).strip()

    # "Decision on you Recon Nomination" doesn't include the name in the
    # subject -- pull it from the body instead.
    soup = BeautifulSoup(html_body, "html.parser")
    candidates = [
        d for d in centered_text_blocks(soup)
        if 3 < len(d) < 80 and "Recon" not in d and "Dear" not in d
    ]
    portal_guess = candidates[0] if candidates else None
    return status, portal_guess


# ---------------------------------------------------------------------------
# Parsing -- Photo submissions
# ---------------------------------------------------------------------------
def parse_photo_portal_name(subject):
    m = re.search(r"photo received for (.+?)!?\s*$", subject, re.IGNORECASE)
    return m.group(1).strip() if m else subject.strip()


def parse_photo_submission_email(subject, html_body):
    """Photo-submission confirmations don't include any text or the actual
    photo -- just the portal name -- so this mostly exists for symmetry with
    parse_nomination_email()."""
    portal_name = parse_photo_portal_name(subject)
    return {
        "portal": portal_name,
        "submission_text": "",
        "supporting_text": "",
        "extra_text": [],
        "submission_photo_url": None,
        "supporting_photo_url": None,
    }


def parse_photo_decision(subject, plaintext_body, html_body):
    """Return ('Accepted'|'Rejected'|None, portal_name).
    e.g. subject: "Niantic Spatial Wayspot media submission decided for X"
    body: "...submission for X on Jan 14, 2026. Congratulations, our team
    has decided to accept..." """
    text = (plaintext_body + " " + html_body).lower()
    status = None
    if "congratulations" in text and "accept" in text:
        status = "Accepted"
    elif "not accept" in text or "unfortunately" in text:
        status = "Rejected"

    m = re.search(r"media submission decided for (.+?)\s*$", subject, re.IGNORECASE)
    portal = m.group(1).strip() if m else None
    return status, portal


# ---------------------------------------------------------------------------
# Parsing -- Edit suggestions
# ---------------------------------------------------------------------------
def parse_edit_portal_name_fallback(subject):
    m = re.search(r"edit suggestion received for (.+?)!?\s*$", subject, re.IGNORECASE)
    return m.group(1).strip() if m else subject.strip()


def parse_edit_submission_email(subject, plaintext_body):
    """Edit-suggestion confirmations lay out three plaintext lines:
        Wayspot: <original portal name>
        Existing <field>: <current value>
        Suggested edit: <proposed value>
    The field name (title/description/location/...) tells us what kind of
    edit this is. Unlike nominations, the reliable portal name here is the
    "Wayspot:" line -- not the subject, which can be blank or malformed for
    edits with no existing value."""
    wayspot_m = re.search(r"Wayspot:[ \t]*(.+)", plaintext_body)
    field_m = re.search(r"Existing (\w[\w\s]*?):[ \t]*(.*)", plaintext_body)
    suggested_m = re.search(r"Suggested edit:[ \t]*(.*)", plaintext_body)

    portal = wayspot_m.group(1).strip() if wayspot_m else parse_edit_portal_name_fallback(subject)
    edit_field = field_m.group(1).strip().title() if field_m else "Unknown"
    existing_value = field_m.group(2).strip() if field_m else ""
    suggested_value = suggested_m.group(1).strip() if suggested_m else ""

    return {
        "portal": portal,
        "edit_field": edit_field,
        "submission_text": f"Existing {edit_field.lower()}: {existing_value}" if existing_value else f"(no existing {edit_field.lower()})",
        "supporting_text": f"Suggested edit: {suggested_value}",
        "extra_text": [],
        "submission_photo_url": None,
        "supporting_photo_url": None,
    }


def parse_edit_decision(plaintext_body, html_body):
    """Return (status, edit_field, submitted_date_iso, portal_guess).
    The decided email body reads like:
        "Thank you for your Wayspot title suggestion for X on Jan 7, 2026.
         Congratulations, our team has decided to accept your Wayspot edit."
    The subject line is NOT used here -- for title edits it shows the
    suggested new title rather than the original portal name, which would
    break matching against the original "received" entry."""
    text = plaintext_body + " " + html_body
    lower = text.lower()

    status = None
    if "congratulations" in lower and "accept" in lower:
        status = "Accepted"
    elif "not accept" in lower or "unfortunately" in lower:
        status = "Rejected"

    m = re.search(
        r"Wayspot (\w[\w\s]*?) suggestion for (.+?) on ([A-Za-z]+ \d{1,2},? \d{4})",
        text,
    )
    if not m:
        return status, None, None, None

    edit_field = m.group(1).strip().title()
    portal_guess = m.group(2).strip()
    try:
        date_iso = datetime.strptime(m.group(3).replace(",", ""), "%b %d %Y").strftime("%Y-%m-%d")
    except ValueError:
        date_iso = None

    return status, edit_field, date_iso, portal_guess


def collect_edits(service):
    print("Searching for 'edit suggestion' received emails...")
    received_ids = list_all_message_ids(service, EDIT_RECEIVED_QUERY)
    print(f"  found {len(received_ids)} messages")

    entries = {}
    for i, msg_id in enumerate(received_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        date_iso = parse_email_date(get_header(payload, "Date"))
        plaintext, _ = extract_bodies(payload)

        parsed = parse_edit_submission_email(subject, plaintext)
        # Key on field + date (mirrors how decisions identify an edit) with
        # portal as a tiebreaker for the rare case of two same-field edits
        # submitted the same day.
        key = (parsed["edit_field"], date_iso, parsed["portal"])
        entries[key] = {
            **parsed,
            "submitted_date": date_iso,
            "status": "Pending",
            "submission_type": "Edit",
        }
        print(f"  [{i}/{len(received_ids)}] {parsed['portal']} ({parsed['edit_field']})")

    print("\nSearching for 'edit suggestion' decision emails...")
    decided_ids = list_all_message_ids(service, EDIT_DECIDED_QUERY)
    print(f"  found {len(decided_ids)} messages")

    for i, msg_id in enumerate(decided_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        plaintext, html = extract_bodies(payload)
        status, edit_field, date_iso, portal_guess = parse_edit_decision(plaintext, html)
        if not status or not edit_field or not date_iso:
            continue

        # Match on field + date first (reliable); fall back to loosest match
        # if the exact portal name drifted (e.g. an accepted title edit).
        match = None
        for key, entry in entries.items():
            if entry["edit_field"] == edit_field and entry["submitted_date"] == date_iso and entry["status"] == "Pending":
                match = entry
                break
        if match:
            match["status"] = status
        print(f"  [{i}/{len(decided_ids)}] {portal_guess} ({edit_field}) -> {status}")

    return list(entries.values())


# ---------------------------------------------------------------------------
# Shared collection logic
# ---------------------------------------------------------------------------
def collect(service, received_query, decided_query, parse_received_fn, parse_decision_fn,
            submission_type, label):
    print(f"Searching for '{label}' received emails...")
    received_ids = list_all_message_ids(service, received_query)
    print(f"  found {len(received_ids)} messages")

    entries = {}
    for i, msg_id in enumerate(received_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        date_iso = parse_email_date(get_header(payload, "Date"))
        _, html = extract_bodies(payload)

        parsed = parse_received_fn(subject, html)
        key = (parsed["portal"], date_iso)
        entries[key] = {
            **parsed,
            "submitted_date": date_iso,
            "status": "Pending",
            "submission_type": submission_type,
        }
        print(f"  [{i}/{len(received_ids)}] {parsed['portal']}")

    print(f"\nSearching for '{label}' decision emails...")
    decided_ids = list_all_message_ids(service, decided_query)
    print(f"  found {len(decided_ids)} messages")

    for i, msg_id in enumerate(decided_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        plaintext, html = extract_bodies(payload)
        status, portal_guess = parse_decision_fn(subject, plaintext, html)
        if not status or not portal_guess:
            continue
        for key, entry in entries.items():
            if entry["portal"].lower() == portal_guess.lower() and entry["status"] == "Pending":
                entry["status"] = status
                break
        print(f"  [{i}/{len(decided_ids)}] {portal_guess} -> {status}")

    return list(entries.values())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    service = get_gmail_service()

    nominations = collect(
        service,
        NOMINATION_RECEIVED_QUERY, NOMINATION_DECIDED_QUERY,
        parse_nomination_email, parse_nomination_decision,
        submission_type="Nomination", label="nomination",
    )
    print()
    photos = collect(
        service,
        PHOTO_RECEIVED_QUERY, PHOTO_DECIDED_QUERY,
        parse_photo_submission_email, parse_photo_decision,
        submission_type="Photo", label="photo submission",
    )
    print()
    edits = collect_edits(service)

    results = nominations + photos + edits
    results.sort(key=lambda r: r["submitted_date"], reverse=True)

    with open("wayspot_submissions.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\nWrote {len(results)} entries to wayspot_submissions.json "
          f"({len(nominations)} nominations, {len(photos)} photo submissions, "
          f"{len(edits)} edit suggestions)")


if __name__ == "__main__":
    main()
