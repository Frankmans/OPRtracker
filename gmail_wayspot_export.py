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

APPEALS -- if a nomination/photo/edit was rejected, you can appeal it:
    "Thanks! Niantic Spatial Wayspot appeal received for ..."           (nomination/photo)
    "Thanks! Niantic Spatial Wayspot title edit appeal received for ..." (edit suggestions)
  decided by (subject guessed -- see warning below):
    "Your Niantic Spatial Wayspot appeal has been decided"

Appeals aren't a new row -- they're a STATUS CHANGE on the original entry.
The appeal email references the original submission by name and date
("...originally submitted on Aug 20, 2025..."), so this script finds that
matching entry and flips its status to "Appeal" rather than creating a
duplicate. If a decided-appeal email is later found for it, that status
updates again to Accepted/Rejected.

*** WARNING: the "decided" appeal email format above was never seen in a  ***
*** real inbox while writing this -- there was no example available. The ***
*** parsing logic is a best-effort guess (looks for "congratulations" /  ***
*** "unfortunately" and tries to find a portal name nearby). If appeal   ***
*** statuses come out wrong, find a real one of these emails, check its  ***
*** actual wording, and update parse_appeal_decision() to match.        ***

Output: wayspot_submissions.json in the same folder, shaped as
  { "exported_at": "<ISO timestamp of this run>", "submissions": [...] }
(the timestamp lets the tracker app show when your Gmail data was actually
last fetched, not just when you happened to click Import). Each entry in
"submissions" is tagged "submission_type": "Nomination", "Photo", or "Edit"
(edits also carry an "edit_field": "Title" / "Description" / "Location" /
etc), and "status" of "Pending", "Accepted", "Rejected", or "Appeal".

INCREMENTAL SYNC -- after the first run, this script only fetches messages
newer than the last run (tracked in sync_state.json, with a 1-day safety
buffer for clock/timezone edge cases), then merges them into the existing
wayspot_submissions.json rather than re-scanning your whole mailbox every
time. This applies to received AND decided/appeal emails alike, so a
decision arriving for a nomination from months ago still gets picked up and
correctly applied to that old entry -- not just to nominations found in the
current run. Delete sync_state.json if you ever want to force a full
historical re-sync from scratch (e.g. after fixing a parsing bug).

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
from google.auth.exceptions import RefreshError
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
# Legacy (pre-"Spatial" rebrand) equivalents -- note the missing "Spatial",
# which keeps these phrase-searches from overlapping with the ones above.
WAYFARER_NOMINATION_RECEIVED_QUERY = 'subject:"Thanks! Niantic Wayspot nomination received for"'
WAYFARER_NOMINATION_DECIDED_QUERY = 'subject:"Niantic Wayspot nomination decided for"'
# OPR ("Operation Portal Recon") -- predates even Wayfarer, sent from
# nominations@portals.ingress.com. Simpler format: one description
# paragraph, one photo, no coordinates anywhere in the body.
OPR_NOMINATION_RECEIVED_QUERY = 'subject:"Portal submission confirmation"'
OPR_NOMINATION_DECIDED_QUERY = 'subject:"Portal review complete"'
PHOTO_RECEIVED_QUERY = 'subject:"Thanks! Niantic Spatial Wayspot Photo received for"'
PHOTO_DECIDED_QUERY = 'subject:"Niantic Spatial Wayspot media submission decided for"'
EDIT_RECEIVED_QUERY = 'subject:"Thanks! Niantic Spatial Wayspot edit suggestion received for"'
EDIT_DECIDED_QUERY = 'subject:"Niantic Spatial Wayspot edit suggestion decided for"'
APPEAL_RECEIVED_QUERY = 'subject:"Thanks! Niantic Spatial Wayspot appeal received"'
APPEAL_EDIT_RECEIVED_QUERY = 'subject:"Thanks! Niantic Spatial Wayspot title edit appeal received for"'
# Guessed subject -- see the WARNING in the module docstring above.
APPEAL_DECIDED_QUERY = 'subject:"Your Niantic Spatial Wayspot appeal has been decided"'

OUTPUT_FILE = "wayspot_submissions.json"
SYNC_STATE_FILE = "sync_state.json"
# Subtracted from the stored last-sync time before building the Gmail
# "after:" filter, as a safety margin against clock skew or a message
# landing a little late. Re-processing an already-known entry is harmless
# (it just re-applies the same data), so a generous buffer costs little.
SYNC_OVERLAP_SECONDS = 86400  # 1 day


def load_previous_results():
    """Loads the previous run's output, if any, so this run can merge into
    it instead of starting from scratch. Returns [] on first run or if the
    file is missing/corrupt. Handles both the current {"exported_at":...,
    "submissions":[...]} format and old plain-array exports from before
    that wrapper existed."""
    if not os.path.exists(OUTPUT_FILE):
        return []
    try:
        with open(OUTPUT_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "submissions" in data:
            return data["submissions"]
        return data  # old format: a bare list
    except (json.JSONDecodeError, OSError):
        print(f"Warning: couldn't read existing {OUTPUT_FILE} -- starting a full sync instead.")
        return []


def load_last_sync():
    """Returns the stored last-sync ISO timestamp, or None if this is the
    first run (in which case a full historical search is done, same as
    before incremental sync existed)."""
    if not os.path.exists(SYNC_STATE_FILE):
        return None
    try:
        with open(SYNC_STATE_FILE, encoding="utf-8") as f:
            return json.load(f).get("last_sync")
    except (json.JSONDecodeError, OSError):
        return None


def save_last_sync(timestamp_iso):
    with open(SYNC_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump({"last_sync": timestamp_iso}, f, indent=2)


def compute_since_epoch(last_sync_iso):
    """Converts the stored last-sync timestamp into a Unix epoch second for
    use in a Gmail "after:<epoch>" search filter (Gmail accepts epoch
    seconds here, giving far better precision than its day-only
    after:YYYY/MM/DD form). Returns None if there's no previous sync
    (-> full search)."""
    if not last_sync_iso:
        return None
    try:
        dt = datetime.strptime(last_sync_iso, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    return max(int(dt.timestamp()) - SYNC_OVERLAP_SECONDS, 0)


def scoped_query(query, since_epoch):
    """Appends an after:<epoch> filter to a query when doing an incremental
    sync; returns the query unchanged for a full (first-run) search."""
    if since_epoch is None:
        return query
    return f"{query} after:{since_epoch}"


def seed_entries(previous_entries, submission_type, key_fn):
    """Builds a starting `entries` dict for a collector from the previous
    run's output, filtered to just its submission_type and keyed the same
    way that collector keys its own newly-fetched entries. This is what lets
    an incremental run still apply new decisions to nominations that were
    fetched in some earlier run, not just ones found this time around."""
    entries = {}
    for e in previous_entries:
        if e.get("submission_type") != submission_type:
            continue
        entry = dict(e)
        entry.pop("_last_decision_date", None)
        entries[key_fn(entry)] = entry
    return entries


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def get_gmail_service():
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except RefreshError:
                # Most common cause: this OAuth app is in Google's "Testing"
                # publishing status (unverified), and Google expires
                # refresh tokens for those after just 7 days -- so this can
                # recur weekly until the app is verified. Rather than crash
                # with a raw traceback, fall back to a fresh login.
                print("Saved login has expired or been revoked (this is normal for an unverified")
                print("OAuth app -- Google expires those refresh tokens after 7 days). ")
                print("Opening a browser window to log in again...\n")
                creds = None
        if not creds or not creds.valid:
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


def parse_coordinates(text):
    """Looks for a "(lat, lng)" pair like the ones the legacy Wayfarer
    nomination emails include, e.g. "(46.400453, 14.100048)". Returns
    (lat_str, lng_str), or (None, None) if not found. Applied to both
    nomination formats in case a future Spatial template adds this too --
    it's currently Wayfarer-only, confirmed by checking a real Spatial
    email, which has no coordinates anywhere in it."""
    m = re.search(r"\(\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\)", text)
    if m:
        return m.group(1), m.group(2)
    return None, None


def parse_nomination_email(subject, plaintext_body, html_body):
    """Extract portal name, submission/supporting text, photo URLs, and
    coordinates (if present -- see parse_coordinates)."""
    soup = BeautifulSoup(html_body, "html.parser")
    portal_name = parse_nomination_portal_name(subject)

    def photo_url(alt_text):
        img = soup.find("img", alt=alt_text)
        return img["src"] if img and img.has_attr("src") else None

    submission_photo = photo_url("Submission Photo")
    supporting_photo = photo_url("Supporting Photo")
    latitude, longitude = parse_coordinates(plaintext_body)

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
        "latitude": latitude,
        "longitude": longitude,
    }


def parse_wayfarer_nomination_email(subject, plaintext_body, html_body):
    """Legacy (pre-'Spatial' rebrand) format: 'Thanks! Niantic Wayspot
    nomination received for X!' from wayfarer.nianticlabs.com. Unlike the
    newer Spatial-branded template (separate styled <div> per line), this
    older one runs everything together in one HTML cell joined by <br>
    tags -- centered_text_blocks() finds nothing useful here, so this parses
    the plaintext body's line structure instead. Photo <img alt="..."> tags
    are the same in both formats, so that part is reused as-is."""
    soup = BeautifulSoup(html_body, "html.parser")
    portal_name = parse_nomination_portal_name(subject)  # same "received for X!" shape

    def photo_url(alt_text):
        img = soup.find("img", alt=alt_text)
        return img["src"] if img and img.has_attr("src") else None

    submission_photo = photo_url("Submission Photo")
    supporting_photo = photo_url("Supporting Photo")
    latitude, longitude = parse_coordinates(plaintext_body)

    lines = [l.strip() for l in plaintext_body.split("\n")]
    try:
        marker_idx = next(
            i for i, l in enumerate(lines)
            if "what you" in l.lower() and "submitted" in l.lower()
        )
    except StopIteration:
        marker_idx = -1

    submission_text, supporting_text, extra_text = "", "", []
    if marker_idx >= 0:
        cleaned = []
        for l in lines[marker_idx + 1:]:
            if not l:
                continue
            if l.startswith("Your nomination will be reviewed") or "Wayfarer Criteria" in l:
                break
            cleaned.append(l)
        # First non-empty line is usually the portal name repeated -- drop it.
        if cleaned and cleaned[0].strip().lower() == portal_name.strip().lower():
            cleaned = cleaned[1:]
        # The coordinate line (now captured separately above) shouldn't also
        # show up as generic extra text.
        cleaned = [l for l in cleaned if not re.fullmatch(r"\(\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*\)", l)]
        if len(cleaned) > 0:
            submission_text = cleaned[0]
        if len(cleaned) > 1:
            supporting_text = cleaned[1]
        if len(cleaned) > 2:
            extra_text = cleaned[2:]

    return {
        "portal": portal_name,
        "submission_text": submission_text,
        "supporting_text": supporting_text,
        "extra_text": extra_text,
        "submission_photo_url": submission_photo,
        "supporting_photo_url": supporting_photo,
        "latitude": latitude,
        "longitude": longitude,
    }


def parse_opr_portal_name(subject):
    m = re.search(r"Portal submission confirmation:\s*(.+?)\s*$", subject, re.IGNORECASE)
    return m.group(1).strip() if m else subject.strip()


def parse_opr_nomination_email(subject, plaintext_body, html_body):
    """OPR ('Operation Portal Recon', predates even Wayfarer) format, sent
    from nominations@portals.ingress.com. Simpler than both later formats:
    only ONE description paragraph (no separate 'supporting text'), only
    ONE photo (alt='Nomination Photo', not a Submission/Supporting pair),
    and no coordinates anywhere in the body -- confirmed by checking a real
    email rather than assumed."""
    portal_name = parse_opr_portal_name(subject)

    soup = BeautifulSoup(html_body, "html.parser")
    img = soup.find("img", alt="Nomination Photo")
    photo_url = img["src"] if img and img.has_attr("src") else None

    lines = [l.strip() for l in plaintext_body.split("\n")]
    try:
        marker_idx = next(i for i, l in enumerate(lines) if "nianticops" in l.lower())
    except StopIteration:
        marker_idx = -1

    submission_text = ""
    if marker_idx >= 0:
        cleaned = [l for l in lines[marker_idx + 1:] if l]
        if cleaned and cleaned[0].strip().lower() == portal_name.strip().lower():
            cleaned = cleaned[1:]
        if cleaned:
            submission_text = cleaned[0]

    return {
        "portal": portal_name,
        "submission_text": submission_text,
        "supporting_text": "",
        "extra_text": [],
        "submission_photo_url": photo_url,
        "supporting_photo_url": None,
        "latitude": None,
        "longitude": None,
    }


def parse_opr_decision(subject, plaintext_body, html_body):
    """Return ('Accepted'|'Rejected'|None, portal_name).
    OPR used at least two different accept templates over its lifetime --
    confirmed real wording:
      accepted (variant 1): "Excellent work, Agent. Thank you for
                 nominating X. We have confirmed this is an eligible
                 Portal nomination."
      accepted (variant 2): "Good work, Agent: we've accepted your
                 submission, and this Portal is now available on your
                 Scanner and on the Intel Map. You have been awarded
                 1000 AP as well as this Portal's Key for your discovery."
      rejected: "Your Portal nomination has been reviewed, and we have
                 decided not to accept this candidate."
    Variant 2 was missed by the original version of this function (it only
    checked for variant 1's specific phrasing), which meant those
    acceptances were silently skipped rather than applied -- caught via a
    real reported example, not by assumption. If a third variant turns up,
    add its distinguishing phrase here the same way.
    "Eligible" here means it passed community review -- Niantic's own
    wording notes final placement can still depend on proximity to other
    Portals, but this is as close to a definitive answer as OPR ever gives,
    so it's treated as the final status for tracking purposes."""
    text = (plaintext_body + " " + html_body).lower()
    status = None
    if "not to accept" in text or "not accept" in text or "unfortunately" in text:
        status = "Rejected"
    elif (
        "eligible portal" in text
        or "excellent work" in text
        or "good work, agent" in text
        or "accepted your submission" in text
        or "portal's key" in text
        or "portal\u2019s key" in text  # curly apostrophe variant
    ):
        status = "Accepted"

    m = re.search(r"Portal review complete:\s*(.+?)\s*$", subject, re.IGNORECASE)
    portal = m.group(1).strip() if m else None
    return status, portal


def parse_nomination_decision(subject, plaintext_body, html_body):
    """Return ('Accepted'|'Rejected'|None, portal_name).
    Tries several ways to find the portal name, in order of reliability,
    since Niantic's "Decision on you Recon Nomination" template isn't
    consistent -- sometimes the name is in the subject, sometimes the body
    isolates it in its own short div, and sometimes it's buried mid-sentence
    in one long paragraph (which broke the old div-length-only heuristic)."""
    text = (plaintext_body + " " + html_body).lower()
    status = None
    if "congratulations" in text and "accept" in text:
        status = "Accepted"
    elif "not accept" in text or "unfortunately" in text:
        status = "Rejected"

    # "Niantic Spatial Wayspot nomination decided for X"
    m = re.search(r"nomination decided for (.+?)!?\s*$", subject, re.IGNORECASE)
    if m:
        return status, m.group(1).strip()

    # "Decision on you Recon Nomination, X" -- name after a comma
    m = re.search(r"Decision on you Recon Nomination,\s*(.+?)\s*$", subject, re.IGNORECASE)
    if m and m.group(1).strip():
        return status, m.group(1).strip()

    # Fall back to the plaintext body's "...nominate X on <date>..." phrasing.
    # Collapse whitespace first: Niantic sometimes wraps this sentence across
    # several lines, which would otherwise break a simple regex match.
    collapsed = re.sub(r"\s+", " ", plaintext_body)
    m = re.search(r"nominate\s+(.+?)\s+on\s+[A-Za-z]+ \d{1,2},? \d{4}", collapsed)
    if m:
        return status, m.group(1).strip()

    # Last resort: a short centered text div (works when Niantic's template
    # isolates the portal name on its own line rather than mid-paragraph).
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
        "suggested_value": suggested_value,
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


def collect_edits(service, since_epoch=None, previous_entries=None):
    entries = seed_entries(previous_entries or [], "Edit",
                            lambda e: (e.get("edit_field", ""), e.get("submitted_date", ""), e["portal"]))

    received_query = scoped_query(EDIT_RECEIVED_QUERY, since_epoch)
    decided_query = scoped_query(EDIT_DECIDED_QUERY, since_epoch)

    print("Searching for 'edit suggestion' received emails...")
    received_ids = list_all_message_ids(service, received_query)
    print(f"  found {len(received_ids)} messages")
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
            "source": "Spatial",
        }
        print(f"  [{i}/{len(received_ids)}] {parsed['portal']} ({parsed['edit_field']})")

    print("\nSearching for 'edit suggestion' decision emails...")
    decided_ids = list_all_message_ids(service, decided_query)
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
            if entry["edit_field"] == edit_field and entry["submitted_date"] == date_iso:
                match = entry
                break
        if match:
            match["status"] = status
        print(f"  [{i}/{len(decided_ids)}] {portal_guess} ({edit_field}) -> {status}")

    return list(entries.values())


# ---------------------------------------------------------------------------
# Parsing -- Appeals (status change on an existing entry, not a new row)
# ---------------------------------------------------------------------------
def parse_appeal_received(subject, plaintext_body, html_body):
    """Figures out what an appeal was filed against by matching the body's
    own wording, since that's more reliable than the subject line:
        "...for your nomination: X, originally submitted on <date>..."
        "...for your Wayspot edit, originally submitted on <date>..."
    A photo-submission appeal pattern is guessed by analogy with the
    nomination one, since no real example was available -- flag this if it
    doesn't match reality.
    Returns a dict with target_type ('Nomination'/'Photo'/'Edit'/'Unknown'),
    portal, original_submitted_date, and (for Edit) edit_field."""
    m_nom = re.search(
        r"for your nomination:\s*(.+?),\s*originally submitted on ([A-Za-z]+ \d{1,2},? \d{4})",
        plaintext_body,
    )
    m_photo = re.search(
        r"for your (?:Wayspot )?[Pp]hoto(?: submission)?:\s*(.+?),\s*originally submitted on ([A-Za-z]+ \d{1,2},? \d{4})",
        plaintext_body,
    )
    m_edit = re.search(
        r"for your Wayspot edit,\s*originally submitted on ([A-Za-z]+ \d{1,2},? \d{4})",
        plaintext_body,
    )

    edit_field = None
    submission_photo_url = None
    supporting_photo_url = None

    if m_nom:
        target_type = "Nomination"
        portal = m_nom.group(1).strip()
        orig_date_raw = m_nom.group(2)
    elif m_photo:
        target_type = "Photo"
        portal = m_photo.group(1).strip()
        orig_date_raw = m_photo.group(2)
    elif m_edit:
        target_type = "Edit"
        orig_date_raw = m_edit.group(1)
        wayspot_m = re.search(r"Wayspot:[ \t]*(.+)", plaintext_body)
        portal = wayspot_m.group(1).strip() if wayspot_m else parse_edit_portal_name_fallback(subject)
    else:
        target_type = "Unknown"
        portal = parse_edit_portal_name_fallback(subject)
        orig_date_raw = None

    try:
        original_submitted_date = (
            datetime.strptime(orig_date_raw.replace(",", ""), "%b %d %Y").strftime("%Y-%m-%d")
            if orig_date_raw else None
        )
    except ValueError:
        original_submitted_date = None

    if target_type == "Edit":
        field_m = re.search(r"Existing (\w[\w\s]*?):[ \t]*(.*)", plaintext_body)
        suggested_m = re.search(r"Suggested edit:[ \t]*(.*)", plaintext_body)
        edit_field = field_m.group(1).strip().title() if field_m else "Unknown"
        existing_value = field_m.group(2).strip() if field_m else ""
        suggested_value = suggested_m.group(1).strip() if suggested_m else ""
        submission_text = f"Existing {edit_field.lower()}: {existing_value}" if existing_value else f"(no existing {edit_field.lower()})"
        supporting_text = f"Suggested edit: {suggested_value}"
    else:
        soup = BeautifulSoup(html_body, "html.parser")

        def photo_url(alt_text):
            img = soup.find("img", alt=alt_text)
            return img["src"] if img and img.has_attr("src") else None

        submission_photo_url = photo_url("Submission Photo")
        supporting_photo_url = photo_url("Supporting Photo")

        text_blocks = centered_text_blocks(soup)
        submission_text, supporting_text = "", ""
        try:
            idx = text_blocks.index(portal)
            remaining = text_blocks[idx + 1:]
            cleaned = []
            for t in remaining:
                if t.startswith("Your appeal will be reviewed") or "Recon Criteria" in t:
                    break
                cleaned.append(t)
            if len(cleaned) > 0:
                submission_text = cleaned[0]
            if len(cleaned) > 1:
                supporting_text = cleaned[1]
        except ValueError:
            pass

    return {
        "target_type": target_type,
        "portal": portal,
        "original_submitted_date": original_submitted_date,
        "edit_field": edit_field,
        "submission_text": submission_text,
        "supporting_text": supporting_text,
        "submission_photo_url": submission_photo_url,
        "supporting_photo_url": supporting_photo_url,
    }


def parse_appeal_decision(plaintext_body, html_body):
    """*** BEST-EFFORT / UNCONFIRMED -- see WARNING in module docstring. ***
    No real example of this email existed when this was written. Looks for
    congratulations/accept vs unfortunately/not-accept keywords, and guesses
    the portal name from a short centered text block in the body."""
    text = plaintext_body + " " + html_body
    lower = text.lower()

    status = None
    if "congratulations" in lower and "accept" in lower:
        status = "Accepted"
    elif "not accept" in lower or "unfortunately" in lower:
        status = "Rejected"

    soup = BeautifulSoup(html_body, "html.parser")
    candidates = [
        d for d in centered_text_blocks(soup)
        if 3 < len(d) < 80 and "Recon" not in d and "Dear" not in d and "appeal" not in d.lower()
    ]
    portal_guess = candidates[0] if candidates else None
    return status, portal_guess


def dates_approximately_match(date_a, date_b, tolerance_days=1):
    """Appeal emails restate the original submission date in prose, which can
    land a day off from the original email's header-derived date depending
    on timezone rendering. Allow a small tolerance rather than requiring an
    exact string match, which would silently fail to link the two."""
    if not date_a or not date_b:
        return False
    if date_a == date_b:
        return True
    try:
        d1 = datetime.strptime(date_a, "%Y-%m-%d")
        d2 = datetime.strptime(date_b, "%Y-%m-%d")
        return abs((d1 - d2).days) <= tolerance_days
    except ValueError:
        return False


def apply_appeals(entries, service, since_epoch=None):
    """Mutates `entries` in place. An appeal doesn't create a new row -- it
    changes the status of the original nomination/photo/edit entry it
    references. Unmatched appeals (shouldn't normally happen, but Niantic's
    wording could vary) are added as new fallback rows instead of silently
    dropped, clearly flagged in their notes."""
    print("Searching for appeal received emails (nomination/photo)...")
    ids_main = list_all_message_ids(service, scoped_query(APPEAL_RECEIVED_QUERY, since_epoch))
    print(f"  found {len(ids_main)} messages")
    print("Searching for appeal received emails (title edit)...")
    ids_edit = list_all_message_ids(service, scoped_query(APPEAL_EDIT_RECEIVED_QUERY, since_epoch))
    print(f"  found {len(ids_edit)} messages")

    all_ids = ids_main + ids_edit
    matched_count = 0
    unmatched = []

    for i, msg_id in enumerate(all_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        plaintext, html = extract_bodies(payload)
        parsed = parse_appeal_received(subject, plaintext, html)

        match = None
        for e in entries:
            if (
                e["portal"].lower() == parsed["portal"].lower()
                and dates_approximately_match(e.get("submitted_date"), parsed["original_submitted_date"])
                and (parsed["target_type"] == "Unknown" or e.get("submission_type") == parsed["target_type"])
            ):
                match = e
                break

        if match:
            match["status"] = "Appeal"
            matched_count += 1
            print(f"  [{i}/{len(all_ids)}] Matched appeal for {parsed['portal']} ({parsed['target_type']}) -> status set to Appeal")
        else:
            unmatched.append(parsed["portal"])
            fallback_type = parsed["target_type"] if parsed["target_type"] != "Unknown" else "Nomination"
            entries.append({
                "portal": parsed["portal"],
                "submitted_date": parsed["original_submitted_date"] or "",
                "status": "Appeal",
                "submission_type": fallback_type,
                "source": "Spatial",
                "edit_field": parsed["edit_field"],
                "submission_text": parsed["submission_text"],
                "supporting_text": parsed["supporting_text"],
                "extra_text": [],
                "submission_photo_url": parsed["submission_photo_url"],
                "supporting_photo_url": parsed["supporting_photo_url"],
                "latitude": None,
                "longitude": None,
                "notes": "Could not automatically match this appeal to an original submission -- added as a new entry for review.",
            })
            print(f"  [{i}/{len(all_ids)}] Could not match appeal for {parsed['portal']} -- added as a new entry instead")

    print(f"\nMarked {matched_count} entries as Appealed.")
    if unmatched:
        print(f"Note: {len(unmatched)} appeal(s) couldn't be matched automatically and were added as new rows: {', '.join(unmatched)}")

    print("\nSearching for decided-appeal emails...")
    print("(format is unconfirmed -- see WARNING in the module docstring)")
    decided_ids = list_all_message_ids(service, scoped_query(APPEAL_DECIDED_QUERY, since_epoch))
    print(f"  found {len(decided_ids)} messages")

    for i, msg_id in enumerate(decided_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        plaintext, html = extract_bodies(payload)
        status, portal_guess = parse_appeal_decision(plaintext, html)
        if not status or not portal_guess:
            print(f"  [{i}/{len(decided_ids)}] Could not parse this decided-appeal email -- skipped")
            continue
        matched = False
        for e in entries:
            if e["portal"].lower() == portal_guess.lower() and e["status"] == "Appeal":
                e["status"] = status
                matched = True
                print(f"  [{i}/{len(decided_ids)}] {portal_guess} appeal -> {status}")
                break
        if not matched:
            print(f"  [{i}/{len(decided_ids)}] Could not match decided appeal for '{portal_guess}' to a Pending appeal")


# ---------------------------------------------------------------------------
# Collection -- Nominations (merges current Spatial + legacy Wayfarer eras)
# ---------------------------------------------------------------------------
def collect_nominations(service, since_epoch=None, previous_entries=None):
    """Niantic rebranded Wayfarer as 'Recon'/'Spatial' at some point, and for
    a transition window sent BOTH old- and new-branded emails for the same
    nomination -- sometimes with conflicting decisions later (e.g. accepted
    under the old system, then rejected under the new one after a re-review).
    This merges both eras: Spatial data wins when both exist for the same
    portal+date, legacy-only nominations are still included, and whichever
    decision email is chronologically LATEST wins the final status -- not
    just whichever was processed first.

    When since_epoch is set (incremental sync), only messages newer than
    that are fetched; the entries dict is pre-seeded from previous_entries
    so decisions can still be matched against nominations found in an
    earlier run.

    Returns (entries, unmatched_decisions). A decision can fail to match by
    name if the portal was renamed via an accepted title-edit suggestion
    between submission and decision -- unmatched_decisions is handed back to
    main() to retry against a title-alias map built from the edit
    suggestions, since this function alone has no visibility into those."""
    entries = seed_entries(previous_entries or [], "Nomination",
                            lambda e: (e["portal"].lower(), e.get("submitted_date", "")))

    spatial_query = scoped_query(NOMINATION_RECEIVED_QUERY, since_epoch)
    wayfarer_query = scoped_query(WAYFARER_NOMINATION_RECEIVED_QUERY, since_epoch)

    print("Searching for nomination received emails (Spatial)...")
    spatial_ids = list_all_message_ids(service, spatial_query)
    print(f"  found {len(spatial_ids)} messages")
    print("Searching for nomination received emails (legacy Wayfarer)...")
    wayfarer_ids = list_all_message_ids(service, wayfarer_query)
    print(f"  found {len(wayfarer_ids)} messages")

    for i, msg_id in enumerate(spatial_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        date_iso = parse_email_date(get_header(payload, "Date"))
        plaintext, html = extract_bodies(payload)
        parsed = parse_nomination_email(subject, plaintext, html)
        key = (parsed["portal"].lower(), date_iso)
        entries[key] = {
            **parsed,
            "submitted_date": date_iso,
            "status": "Pending",
            "submission_type": "Nomination",
            "source": "Spatial",
            "_last_decision_date": None,
        }
        print(f"  [Spatial {i}/{len(spatial_ids)}] {parsed['portal']}")

    legacy_only_count = 0
    for i, msg_id in enumerate(wayfarer_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        date_iso = parse_email_date(get_header(payload, "Date"))
        plaintext, html = extract_bodies(payload)
        parsed = parse_wayfarer_nomination_email(subject, plaintext, html)
        key = (parsed["portal"].lower(), date_iso)
        if key in entries and entries[key].get("source") == "Spatial":
            print(f"  [Wayfarer {i}/{len(wayfarer_ids)}] {parsed['portal']} -- already captured via Spatial email, skipped")
            continue
        entries[key] = {
            **parsed,
            "submitted_date": date_iso,
            "status": "Pending",
            "submission_type": "Nomination",
            "source": "Wayfarer",
            "_last_decision_date": None,
        }
        legacy_only_count += 1
        print(f"  [Wayfarer {i}/{len(wayfarer_ids)}] {parsed['portal']} (legacy-only nomination)")

    print(f"\n{legacy_only_count} nomination(s) existed only in the legacy Wayfarer emails.")

    opr_query = scoped_query(OPR_NOMINATION_RECEIVED_QUERY, since_epoch)
    print("Searching for nomination received emails (legacy OPR)...")
    opr_ids = list_all_message_ids(service, opr_query)
    print(f"  found {len(opr_ids)} messages")

    opr_only_count = 0
    for i, msg_id in enumerate(opr_ids, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        date_iso = parse_email_date(get_header(payload, "Date"))
        plaintext, html = extract_bodies(payload)
        parsed = parse_opr_nomination_email(subject, plaintext, html)
        key = (parsed["portal"].lower(), date_iso)
        if key in entries and entries[key].get("source") in ("Spatial", "Wayfarer"):
            print(f"  [OPR {i}/{len(opr_ids)}] {parsed['portal']} -- already captured via a newer-era email, skipped")
            continue
        entries[key] = {
            **parsed,
            "submitted_date": date_iso,
            "status": "Pending",
            "submission_type": "Nomination",
            "source": "OPR",
            "_last_decision_date": None,
        }
        opr_only_count += 1
        print(f"  [OPR {i}/{len(opr_ids)}] {parsed['portal']} (legacy-only nomination)")

    print(f"{opr_only_count} nomination(s) existed only in the legacy OPR emails.")

    spatial_decided_query = scoped_query(NOMINATION_DECIDED_QUERY, since_epoch)
    wayfarer_decided_query = scoped_query(WAYFARER_NOMINATION_DECIDED_QUERY, since_epoch)
    opr_decided_query = scoped_query(OPR_NOMINATION_DECIDED_QUERY, since_epoch)

    print("\nSearching for nomination decision emails (Spatial)...")
    spatial_decided_ids = list_all_message_ids(service, spatial_decided_query)
    print(f"  found {len(spatial_decided_ids)} messages")
    print("Searching for nomination decision emails (legacy Wayfarer)...")
    wayfarer_decided_ids = list_all_message_ids(service, wayfarer_decided_query)
    print(f"  found {len(wayfarer_decided_ids)} messages")
    print("Searching for nomination decision emails (legacy OPR)...")
    opr_decided_ids = list_all_message_ids(service, opr_decided_query)
    print(f"  found {len(opr_decided_ids)} messages")

    all_decided = (
        [(mid, "Spatial", parse_nomination_decision) for mid in spatial_decided_ids]
        + [(mid, "Wayfarer", parse_nomination_decision) for mid in wayfarer_decided_ids]
        + [(mid, "OPR", parse_opr_decision) for mid in opr_decided_ids]
    )

    unmatched_decisions = []
    for i, (msg_id, source, parse_decision_fn) in enumerate(all_decided, 1):
        msg = get_message(service, msg_id)
        payload = msg["payload"]
        subject = get_header(payload, "Subject")
        decision_date = parse_email_date(get_header(payload, "Date"))
        plaintext, html = extract_bodies(payload)
        status, portal_guess = parse_decision_fn(subject, plaintext, html)
        if not status or not portal_guess:
            print(f"  [{source} {i}/{len(all_decided)}] Could not parse this decision email -- skipped")
            continue

        # NOTE: matches by portal name only (not date), same limitation the
        # original code had. If the same portal name was nominated more than
        # once, a decision could in rare cases match the wrong instance.
        match = None
        for e in entries.values():
            if e["portal"].lower() == portal_guess.lower():
                match = e
                break
        if not match:
            # Doesn't necessarily mean this decision is lost -- it might
            # reference a title that was later changed via an accepted edit
            # suggestion. main() retries these against a title-alias map
            # built from the edit suggestions once those are collected.
            unmatched_decisions.append({
                "status": status, "portal_guess": portal_guess,
                "decision_date": decision_date, "source": source,
            })
            print(f"  [{source} {i}/{len(all_decided)}] {portal_guess} -> {status} (no matching nomination found yet -- will retry against title-edit aliases)")
            continue

        prev_date = match.get("_last_decision_date")
        if prev_date is None or (decision_date and decision_date >= prev_date):
            match["status"] = status
            match["_last_decision_date"] = decision_date
            print(f"  [{source} {i}/{len(all_decided)}] {portal_guess} -> {status} (decided {decision_date or 'unknown date'})")
        else:
            print(f"  [{source} {i}/{len(all_decided)}] {portal_guess} -> {status} (decided {decision_date}) -- older than an already-applied decision, ignored")

    for e in entries.values():
        e.pop("_last_decision_date", None)

    return list(entries.values()), unmatched_decisions


def collect(service, received_query, decided_query, parse_received_fn, parse_decision_fn,
            submission_type, label, since_epoch=None, previous_entries=None):
    entries = seed_entries(previous_entries or [], submission_type,
                            lambda e: (e["portal"], e.get("submitted_date", "")))

    received_query = scoped_query(received_query, since_epoch)
    decided_query = scoped_query(decided_query, since_epoch)

    print(f"Searching for '{label}' received emails...")
    received_ids = list_all_message_ids(service, received_query)
    print(f"  found {len(received_ids)} messages")

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
            "source": "Spatial",
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
            if entry["portal"].lower() == portal_guess.lower():
                entry["status"] = status
                break
        print(f"  [{i}/{len(decided_ids)}] {portal_guess} -> {status}")

    return list(entries.values())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Reconciliation -- resolve nomination decisions whose portal name changed
# ---------------------------------------------------------------------------
def build_title_alias_map(edits):
    """Maps a portal's current (post-edit) name -> its original submitted
    name, from every ACCEPTED title-edit suggestion. Used to resolve
    nomination decisions that reference a name the portal was renamed to
    after submission but before the decision arrived."""
    aliases = {}
    for e in edits:
        if e.get("edit_field") == "Title" and e.get("status") == "Accepted" and e.get("suggested_value"):
            new_name = e["suggested_value"].strip().lower()
            original_name = e["portal"].strip().lower()
            if new_name and new_name != original_name:
                aliases[new_name] = original_name
    return aliases


def resolve_via_title_aliases(name, title_aliases):
    """Follows a chain of renames backwards (a portal can be renamed more
    than once) to find the earliest known name, with a cycle guard in case
    of any data weirdness."""
    seen = set()
    current = name.strip().lower()
    while current in title_aliases and current not in seen:
        seen.add(current)
        current = title_aliases[current]
    return current


def resolve_unmatched_nomination_decisions(nominations, unmatched_decisions, title_aliases):
    """Retries decisions that didn't match any nomination by name, using the
    title-alias map. Anything still unmatched after this is added as its own
    flagged row rather than silently dropped -- this is the verification
    step: every accepted/rejected decision this script finds ends up
    reflected somewhere in the output, one way or another."""
    still_unmatched = []
    resolved_count = 0

    for dec in unmatched_decisions:
        resolved_name = resolve_via_title_aliases(dec["portal_guess"], title_aliases)
        match = None
        for e in nominations:
            if e["portal"].strip().lower() == resolved_name:
                match = e
                break
        if match:
            match["status"] = dec["status"]
            resolved_count += 1
            print(f"  Resolved via title-edit history: '{dec['portal_guess']}' -> '{match['portal']}' ({dec['status']})")
        else:
            still_unmatched.append(dec)

    if resolved_count:
        print(f"\n{resolved_count} decision(s) matched after following title-edit history.")

    if still_unmatched:
        print(f"\nWARNING: {len(still_unmatched)} decision(s) could not be matched to any nomination, "
              f"even after checking title-edit aliases. Adding them as flagged rows so nothing is lost:")
        for dec in still_unmatched:
            print(f"  - '{dec['portal_guess']}' -> {dec['status']} (decided {dec['decision_date'] or 'unknown date'}, {dec['source']})")
            nominations.append({
                "portal": dec["portal_guess"],
                "submitted_date": dec["decision_date"] or "",
                "status": dec["status"],
                "submission_type": "Nomination",
                "source": dec["source"],
                "submission_text": "",
                "supporting_text": "",
                "extra_text": [],
                "submission_photo_url": None,
                "supporting_photo_url": None,
                "latitude": None,
                "longitude": None,
                "notes": "Could not automatically match this decision to a submitted nomination (possibly renamed) -- added for manual review.",
            })
    else:
        print("\nAll decision emails were successfully matched to a nomination. ✓")

    return nominations


def main():
    service = get_gmail_service()

    previous_results = load_previous_results()
    last_sync = load_last_sync()
    since_epoch = compute_since_epoch(last_sync)
    run_started_at = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    if since_epoch is not None:
        print(f"Incremental sync: only fetching messages since {last_sync} (with a 1-day safety buffer).")
        print(f"Loaded {len(previous_results)} existing entries to merge into.\n")
    else:
        print("No previous sync found (or no wayspot_submissions.json/sync_state.json yet) -- doing a full historical search.\n")

    nominations, unmatched_decisions = collect_nominations(service, since_epoch, previous_results)
    print()
    photos = collect(
        service,
        PHOTO_RECEIVED_QUERY, PHOTO_DECIDED_QUERY,
        parse_photo_submission_email, parse_photo_decision,
        submission_type="Photo", label="photo submission",
        since_epoch=since_epoch, previous_entries=previous_results,
    )
    print()
    edits = collect_edits(service, since_epoch, previous_results)

    print()
    if unmatched_decisions:
        print(f"Reconciling {len(unmatched_decisions)} nomination decision(s) that didn't match by name "
              f"(checking whether the portal was renamed via an accepted title edit)...")
        title_aliases = build_title_alias_map(edits)
        nominations = resolve_unmatched_nomination_decisions(nominations, unmatched_decisions, title_aliases)
    else:
        print("Every nomination decision matched an existing entry by name -- no reconciliation needed. ✓")

    results = nominations + photos + edits
    print()
    apply_appeals(results, service, since_epoch)

    results.sort(key=lambda r: r["submitted_date"], reverse=True)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"exported_at": run_started_at, "submissions": results}, f, ensure_ascii=False, indent=2)

    save_last_sync(run_started_at)

    appeal_count = sum(1 for r in results if r["status"] == "Appeal")
    print(f"\nWrote {len(results)} entries to {OUTPUT_FILE} "
          f"({len(nominations)} nominations, {len(photos)} photo submissions, "
          f"{len(edits)} edit suggestions, {appeal_count} currently under appeal)")
    print(f"Sync state saved to {SYNC_STATE_FILE} -- next run will only check for messages after this point.")
    print("(Delete sync_state.json if you ever want to force a full re-sync from scratch.)")


if __name__ == "__main__":
    main()
