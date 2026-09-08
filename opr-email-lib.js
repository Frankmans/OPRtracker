// ===========================================================================
// opr-email-lib.js
//
// A vanilla-JS port of bilde2910/OPR-Tools' src/email module
// (https://github.com/bilde2910/OPR-Tools/tree/main/src/email), for use in
// standalone Tampermonkey userscripts that have no build step / bundler.
//
// Ported pieces, each mirroring the upstream file of the same purpose:
//   - errors.ts    -> error classes
//   - types.ts     -> EmailType / EmailStyle enums, Header/StoredEmail shape
//   - parsing.ts   -> parseMIME, extractEmail, decodeBodyUsingCTE (RFC 2047,
//                      quoted-printable, base64)
//   - templates.ts -> the full subject-line classification template table,
//                      byte-for-byte (only TypeScript type annotations were
//                      stripped -- every regex and disambiguate() function
//                      body is unmodified)
//   - index.ts     -> the Email class (headers/body access, multipart
//                      alternative extraction, classify()) and
//                      EmailAPI.stripDiacritics()
//
// Deliberately NOT ported: EmailAPI's IndexedDB storage/import-listener
// machinery (index.ts's EmailAPI class) -- that's specific to the full
// OPR-Tools web app's DB layer. The importer userscript in this repo has
// its own lightweight IndexedDB store instead, using the same StoredEmail
// shape so the two are still compatible.
//
// Exposed as a single global: window.OPREmail
// ===========================================================================
(function (global) {
  "use strict";

  // -------------------------------------------------------------------------
  // errors.ts
  // -------------------------------------------------------------------------
  class InvalidEmailFormatError extends Error {}
  class NotImplementedError extends Error {}
  class InvalidContentTypeError extends Error {}
  class HeaderNotFoundError extends Error {}
  class NoMatchingTemplateError extends Error {}
  class DisambiguationFailedError extends Error {}

  // -------------------------------------------------------------------------
  // types.ts
  // -------------------------------------------------------------------------
  const Type = {
    CHALLENGE_REWARD: "CHALLENGE_REWARD",
    EDIT_APPEAL_DECIDED: "EDIT_APPEAL_DECIDED",
    EDIT_APPEAL_RECEIVED: "EDIT_APPEAL_RECEIVED",
    EDIT_DECIDED: "EDIT_DECIDED",
    EDIT_RECEIVED: "EDIT_RECEIVED",
    MISCELLANEOUS: "MISCELLANEOUS",
    NOMINATION_APPEAL_DECIDED: "NOMINATION_APPEAL_DECIDED",
    NOMINATION_APPEAL_RECEIVED: "NOMINATION_APPEAL_RECEIVED",
    NOMINATION_DECIDED: "NOMINATION_DECIDED",
    NOMINATION_RECEIVED: "NOMINATION_RECEIVED",
    PHOTO_DECIDED: "PHOTO_DECIDED",
    PHOTO_RECEIVED: "PHOTO_RECEIVED",
    REPORT_DECIDED: "REPORT_DECIDED",
    REPORT_RECEIVED: "REPORT_RECEIVED",
    SURVEY: "SURVEY",
    // ---- non-upstream: Niantic Support / Helpshift abuse-report tickets ----
    // Distinct from REPORT_RECEIVED/REPORT_DECIDED above, which are the
    // Wayfarer app's own "report a Wayspot" flow (a specific Wayspot is
    // wrong/doesn't exist). ABUSE_REPORT_* instead covers the "Reporting
    // Abuse in Wayfarer" Helpshift support ticket -- reporting abusive
    // *behavior* (e.g. fake nominations to manipulate the gameboard), filed
    // as a freeform support conversation rather than through a templated
    // per-submission notification email. See the "helpshift.ts" section
    // below for why this needs its own thread-parsing logic.
    //
    // RECEIVED/PENDING/ACTIONED/DENIED are matched against Niantic
    // Support's own confirmed canned reply text (see RESOLUTION_TEMPLATES
    // below) -- UPDATED is the catch-all for anything else (a custom
    // human reply, the reporter's own follow-up being the newest message,
    // etc.), not a fourth canned outcome.
    ABUSE_REPORT_RECEIVED: "ABUSE_REPORT_RECEIVED",
    ABUSE_REPORT_PENDING: "ABUSE_REPORT_PENDING",
    ABUSE_REPORT_ACTIONED: "ABUSE_REPORT_ACTIONED",
    ABUSE_REPORT_DENIED: "ABUSE_REPORT_DENIED",
    ABUSE_REPORT_UPDATED: "ABUSE_REPORT_UPDATED",
  };

  const Style = {
    INGRESS: "INGRESS",
    LIGHTSHIP: "LIGHTSHIP",
    POKEMON_GO: "POKEMON_GO",
    REDACTED: "REDACTED",
    WAYFARER: "WAYFARER",
    RECON: "RECON",
    UNKNOWN: "UNKNOWN",
    // non-upstream: see ABUSE_REPORT_* above
    SUPPORT: "SUPPORT",
  };

  // -------------------------------------------------------------------------
  // diacritics.json
  // -------------------------------------------------------------------------
  const DIACRITICS = {"A":"ÀÁÂÃÅÄĀĂĄǍǞǠǺȀȂȦ","C":"ÇĆĈĊČ","D":"Ď","E":"ÈÊËÉĒĔĖĘĚȄȆȨ","G":"ĜĞĠĢǦǴ","H":"ĤȞ","I":"ÌÍÎÏĨĪĬĮİǏȈȊ","J":"Ĵ","K":"ĶǨ","L":"ĹĻĽ","N":"ÑŃŅŇǸ","O":"ÒÔÕÓÖŌŎŐƠǑǪǬȌȎȪȬȮȰ","R":"ŔŖŘȐȒ","S":"ŚŜŞŠȘ","T":"ŢŤȚ","U":"ÙÚÛÜŨŪŬŮŰŲƯǓǕǗǙǛȔȖ","W":"Ŵ","Y":"ÝŶŸȲ","Z":"ŹŻŽ","a":"àáâãåäāăąǎǟǡǻȁȃȧ","c":"çćĉċč","d":"ď","e":"èêëéēĕėęěȅȇȩ","g":"ĝğġģǧǵ","h":"ĥȟ","i":"ìíîïĩīĭįǐȉȋ","j":"ĵǰ","k":"ķǩ","l":"ĺļľ","n":"ñńņňǹ","o":"òôõóöōŏőơǒǫǭȍȏȫȭȯȱ","r":"ŕŗřȑȓ","s":"śŝşšș","t":"ţťț","u":"ùúûüũūŭůűųưǔǖǘǚǜȕȗ","w":"ŵ","y":"ýÿŷȳ","z":"źżž","Æ":"ǢǼ","Ø":"Ǿ","æ":"ǣǽ","ø":"ǿ","Ʒ":"Ǯ","ʒ":"ǯ","'":"\""};

  function stripDiacritics(text) {
    for (const [k, v] of Object.entries(DIACRITICS)) {
      text = text.replace(new RegExp(`[${v}]`, "g"), k);
    }
    return text.normalize("NFD");
  }

  // -------------------------------------------------------------------------
  // parsing.ts
  // -------------------------------------------------------------------------
  const ENCODED_WORD_REGEX = /=\?([A-Za-z0-9-]+)\?([QqBb])\?([^?]+)\?=(?:\s+(?==\?[A-Za-z0-9-]+\?[QqBb]\?[^?]+\?=))?/g;

  const extractEmail = (headerValue) => {
    // Technically not spec-compliant
    const sb = headerValue.lastIndexOf("<");
    const eb = headerValue.lastIndexOf(">");
    if (sb < 0 && eb < 0) return headerValue;
    return headerValue.substring(sb + 1, eb);
  };

  const parseMIME = (data) => {
    const bound = data.indexOf("\r\n\r\n");
    if (bound < 0) throw new InvalidEmailFormatError("Cannot find boundary between headers and body");
    const headers = data.substring(0, bound).replace(/\r\n\s/g, " ").split(/\r\n/).map((h) => parseHeader(h));
    const body = data.substring(bound + 4);
    return new Email(headers, body);
  };

  const parseHeader = (headerLine) => {
    const b = headerLine.indexOf(":");
    const token = headerLine.substring(0, b);
    // Decode RFC 2047 atoms
    const field = headerLine
      .substring(b + 1)
      .trim()
      .replace(ENCODED_WORD_REGEX, (_, c, e, t) => parseEncodedWord(c, e, t));
    return {
      name: token,
      value: field.trim(),
    };
  };

  const parseEncodedWord = (charset, encoding, text) => {
    switch (encoding) {
      case "Q":
      case "q":
        return new TextDecoder(charset).decode(qpStringToU8A(text.split("_").join(" ")));
      case "B":
      case "b":
        return charset.toLowerCase() == "utf-8" ? atobUTF8(text) : atob(text);
      default:
        throw new InvalidEmailFormatError(`Invalid RFC 2047 encoding format: ${encoding}`);
    }
  };

  const qpStringToU8A = (str) => {
    const u8a = new Uint8Array(str.length - (2 * (str.split("=").length - 1)));
    for (let i = 0, j = 0; i < str.length; i++, j++) {
      if (str[i] !== "=") {
        u8a[j] = str.codePointAt(i);
      } else {
        u8a[j] = parseInt(str.substring(i + 1, i + 3), 16);
        i += 2;
      }
    }
    return u8a;
  };

  // https://stackoverflow.com/a/30106551/1955334
  const atobUTF8 = (text) => decodeURIComponent(atob(text)
    .split("")
    .map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
    .join(""));

  const decodeBodyUsingCTE = (body, cte, charset) => {
    switch (cte) {
      case null:
      // BUGFIX (not upstream -- confirmed against a real ticket-reply
      // export that used this exact CTE, which is why it wasn't caught
      // sooner): 7bit/8bit/binary are legal Content-Transfer-Encoding
      // values per RFC 2045 \u00a76 -- they mean "no transfer encoding was
      // applied", not "unencoded/absent" specifically, which is a
      // distinct case from CTE being missing entirely (the `null` this
      // switch already handled). Both cases need the exact same
      // treatment though: the body is already usable text as read off
      // the wire, nothing to decode. Falling through to `case null`'s
      // `return body` for these was missing entirely before -- any
      // abuse-report (or other) email using one of these instead of
      // quoted-printable/base64 hit the `default` branch below and threw
      // NotImplementedError, which classify()'s caller (isAbuseReportRecord()/
      // scanImportedEmails() in the extractor script) treats as "not an
      // abuse report" and silently drops -- so the whole ticket just
      // never showed up in a scan, with nothing in the log to say why.
      case "7bit":
      case "8bit":
      case "binary":
        return body;
      case "quoted-printable":
        return unfoldQuotedPrintable(body, charset);
      case "base64":
        return charset.toLowerCase() === "utf-8" ? atobUTF8(body) : atob(body);
      default:
        throw new NotImplementedError(`Unknown Content-Transfer-Encoding ${cte}`);
    }
  };

  const unfoldQuotedPrintable = (body, charset) => {
    // Unfold QP CTE
    const td = new TextDecoder(charset);
    return body
      .split(/=\r?\n/).join("")
      .split(/\r?\n/).map((line) => td.decode(qpStringToU8A(line)))
      .join("\n");
  };

  // -------------------------------------------------------------------------
  // index.ts -- Email class
  // -------------------------------------------------------------------------
  class Email {
    constructor(headers, body) {
      this.headers = headers;
      this.body = body;
      this._cache = {};
    }

    getHeaderValues(name) {
      return this.headers
        .filter((h) => h.name.toLowerCase() === name.toLowerCase())
        .map((h) => h.value);
    }

    getFirstHeaderValue(name, defaultValue) {
      const hvs = this.getHeaderValues(name);
      if (hvs.length) return hvs[0];
      if (typeof defaultValue !== "undefined") return defaultValue;
      throw new HeaderNotFoundError(`Could not find any headers with name ${name}`);
    }

    getBody(contentType) {
      const alts = this.getMultipartAlternatives();
      return alts[contentType.toLowerCase()] ?? null;
    }

    getMultipartAlternatives() {
      const alts = {};
      const ct = this._parseContentType(this.getFirstHeaderValue("Content-Type"));
      if (ct.type === "multipart/alternative") {
        const parts = this.body.split(`--${ct.params.boundary}`).filter(part => part !== "");
        for (const part of parts) {
          if (!part.startsWith("\r\n") || !part.endsWith("\r\n")) continue;
          const partMime = parseMIME(part.substring(2, part.length - 2));
          if (partMime.body.trim().length === 0) continue;
          const partCTHdr = partMime.getFirstHeaderValue("Content-Type", null);
          if (partCTHdr === null) continue;
          const partCT = this._parseContentType(partCTHdr);
          const partCTE = partMime.getFirstHeaderValue("Content-Transfer-Encoding", null);
          const partCharset = (partCT.params.charset ?? "utf-8").toLowerCase();
          alts[partCT.type] = decodeBodyUsingCTE(partMime.body, partCTE, partCharset);
        }
      } else {
        const cte = this.getFirstHeaderValue("Content-Transfer-Encoding", null);
        const charset = (ct.params.charset ?? "utf-8").toLowerCase();
        alts[ct.type] = decodeBodyUsingCTE(this.body, cte, charset);
      }
      return alts;
    }

    getDocument() {
      if (typeof this._cache.document !== "undefined") {
        return this._cache.document;
      } else {
        const html = this.getBody("text/html");
        if (!html) return null;
        const dp = new DOMParser();
        this._cache.document = dp.parseFromString(html, "text/html");
        return this._cache.document;
      }
    }

    classify() {
      if (typeof this._cache.classification !== "undefined") {
        if (this._cache.classification === null) {
          throw new DisambiguationFailedError("Disambiguation of ambiguous email template failed");
        }
        return this._cache.classification;
      } else {
        const subject = this.getFirstHeaderValue("Subject");
        for (const template of TEMPLATES) {
          if (subject.match(template.subject)) {
            if ("disambiguate" in template && typeof template.disambiguate !== "undefined") {
              this._cache.classification = template.disambiguate(this);
            } else if ("type" in template) {
              this._cache.classification = {
                type: template.type,
                style: template.style,
                language: template.language,
              };
            } else {
              this._cache.classification = null;
            }
            return this.classify();
          }
        }
      }
      throw new NoMatchingTemplateError("This email does not appear to match any styles of Niantic emails currently known to Email API.");
    }

    _parseContentType(ctHeader) {
      const m = ctHeader.match(/^([^/]+\/[^/;\s]+)(?=($|((?:;[^;]*)*)))/);
      if (m === null) throw new InvalidContentTypeError(`Unrecognized Content-Type ${ctHeader}`);
      const type = m[1];
      const params = m[2];
      const paramMap = {};
      if (params) {
        const paramList = params.substring(1).split(";");
        for (const param of paramList) {
          const [attr, value] = param.trim().split("=");
          if (!attr || typeof value === "undefined") continue;
          paramMap[attr.toLowerCase()] = (
            value.startsWith("\"") && value.endsWith("\"")
              ? value.substring(1, value.length - 1)
              : value
          );
        }
      }
      return {
        type: type.toLowerCase(),
        params: paramMap,
      };
    }
  }

  // -------------------------------------------------------------------------
  // helpshift.ts -- NON-UPSTREAM. bilde2910/OPR-Tools has no equivalent of
  // this: every upstream template matches a single templated notification
  // email for one submission. Niantic's "Reporting Abuse in Wayfarer" flow
  // is different -- it opens a Helpshift support ticket, and Niantic mails
  // you the *whole conversation thread so far* on every reply, using the
  // same subject line throughout (only a leading "Re: " distinguishes a
  // reply from -- presumably -- the original). The thread body isn't one of
  // the styled per-language templates above; it's a plain delimited
  // transcript ("----...----" rules bracketing "Author | Date | Time"
  // headers), with the user's original form submission embedded as
  // literal, unescaped HTML (<strong>/<br> tags and all) inside what's
  // nominally the text/plain part. This section parses that transcript
  // structure and the abuse-report form fields inside it; only confirmed
  // against a single real "ticket just opened" auto-acknowledgement email,
  // so treat anything not explicitly flagged confirmed below with caution.
  // -------------------------------------------------------------------------

  // Splits a Helpshift transcript body into its per-message blocks, plus
  // the trailing "Conversation ID: #NNNN" footer if present. Each block is
  // delimited by a pair of "----...----" rule lines around an
  // "Author | Month Day, Year | HH:MM +ZZZZ" header line.
  const HELPSHIFT_RULE_RE = /^-{3,}$/;
  // Author is (.*?), not (.+?): Helpshift renders the *reporter's own*
  // messages in the thread with a blank author (just a leading space
  // before the first "|", e.g. " | August 13, 2026 | 12:02 +0200") --
  // confirmed against a real ticket where the original report submission
  // itself (the message carrying the form fields we actually want) has a
  // blank author. Requiring 1+ chars here silently dropped every message
  // from the reporter, including that one -- which is why extraction was
  // coming back empty for tickets where the report/reply text lives in a
  // blank-author block rather than a named one.
  const HELPSHIFT_HEADER_RE = /^(.*?)\s*\|\s*(.+?)\s*\|\s*([\d:]{3,5}\s*[+-]\d{2}:?\d{2})$/;
  const HELPSHIFT_CONVERSATION_ID_RE = /^Conversation ID:\s*#?(\d+)/;

  const parseHelpshiftThread = (plaintext) => {
    // BUGFIX (not upstream -- found via the same real ticket-reply export
    // as the CTE fix above): splitting on "\n" alone, when the decoded
    // body is still CRLF (which it always is here -- parseMIME normalizes
    // the whole raw message to CRLF up front, and nothing decodes it away
    // in between), leaves every line's trailing "\r" attached to the
    // *start* of the next split, i.e. embedded at each line boundary
    // inside `raw` once bodyLines.join("\n") reassembles them. Harmless
    // for most of this file's regexes ([\s\S]*? swallows it fine), but
    // HELPSHIFT_FORM_FIELD_RE's *last* field in a message has to end at
    // "<br><br>" or the true end of string ($) -- and the real end of
    // string here was "...</strong>\r", one character past where $ could
    // match. That silently dropped the LAST field in any Helpshift form
    // submission from `fields` -- which for Niantic's abuse-report form
    // is "Provide details of the location(s)", i.e. the one field this
    // whole plugin most needs. Normalizing to bare "\n" before splitting,
    // rather than leaving it to whoever consumes `raw` later to notice
    // and strip it themselves, fixes this at the source for every
    // consumer at once.
    const lines = (plaintext || "").replace(/\r\n?/g, "\n").split("\n");
    const ruleIdx = [];
    lines.forEach((l, i) => {
      if (HELPSHIFT_RULE_RE.test(l.trim())) ruleIdx.push(i);
    });

    const messages = [];
    let conversationId = null;
    let i = 0;
    while (i < ruleIdx.length) {
      const start = ruleIdx[i];
      const headerLine = (lines[start + 1] || "").trim();

      const convMatch = HELPSHIFT_CONVERSATION_ID_RE.exec(headerLine);
      if (convMatch) {
        conversationId = convMatch[1];
        i += 1;
        continue;
      }

      const hm = HELPSHIFT_HEADER_RE.exec(headerLine);
      if (hm && ruleIdx[i + 1] === start + 2) {
        const bodyStart = start + 3;
        const bodyEnd = typeof ruleIdx[i + 2] !== "undefined" ? ruleIdx[i + 2] : lines.length;
        const bodyLines = lines.slice(bodyStart, bodyEnd);
        while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
        while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
        messages.push({
          author: hm[1].trim(),
          date: hm[2].trim(),
          time: hm[3].trim(),
          raw: bodyLines.join("\n"),
        });
        i += 2;
      } else {
        // Unrecognized header between a rule pair -- skip just this one
        // rule rather than getting stuck, so one odd block doesn't prevent
        // parsing the rest of the thread.
        i += 1;
      }
    }

    return { conversationId, messages };
  };

  // Strips the literal <strong>/<br>/<a> markup embedded in a Helpshift
  // form-submission message down to plain text, for keyword matching.
  const stripHelpshiftMarkup = (html) =>
    (html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?a[^>]*>/gi, "")
      .replace(/<\/?strong>/gi, "")
      .trim();

  // Niantic's Wayfarer abuse-report form dumps as
  // "<strong>{form title}</strong><br><br>{label}<br><strong>{value}</strong><br><br>{label2}<br><strong>{value2}</strong>..."
  // -- extract the title and each label/value pair.
  const HELPSHIFT_FORM_TITLE_RE = /^<strong>(.*?)<\/strong><br\s*\/?><br\s*\/?>/i;
  const HELPSHIFT_FORM_FIELD_RE = /([^<]+?)<br\s*\/?><strong>([\s\S]*?)<\/strong>(?:<br\s*\/?><br\s*\/?>|$)/gi;

  const extractHelpshiftFormFields = (rawMessage) => {
    const text = rawMessage || "";
    const titleMatch = HELPSHIFT_FORM_TITLE_RE.exec(text);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const rest = titleMatch ? text.slice(titleMatch[0].length) : text;

    const fields = {};
    let m;
    HELPSHIFT_FORM_FIELD_RE.lastIndex = 0;
    while ((m = HELPSHIFT_FORM_FIELD_RE.exec(rest)) !== null) {
      const label = m[1].trim();
      const value = stripHelpshiftMarkup(m[2]).trim();
      if (label) fields[label] = value;
    }
    return { title, fields };
  };

  // Finds bare "lat,lon" pairs (no surrounding parentheses, unlike the
  // "(lat, lon)" format used elsewhere) -- the format Niantic's abuse-report
  // form uses both for the reporter-supplied coordinates and for whatever
  // Street View / map link they pasted in.
  const HELPSHIFT_COORD_RE = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/g;

  const extractHelpshiftCoordinates = (text) => {
    const out = [];
    let m;
    HELPSHIFT_COORD_RE.lastIndex = 0;
    while ((m = HELPSHIFT_COORD_RE.exec(text || "")) !== null) {
      out.push({ latitude: m[1], longitude: m[2] });
    }
    return out;
  };

  // Best-effort: "Provide details of the location(s)" reads as
  // "<name>, <lat>,<lon>" in one confirmed sample ("Bulskampveldroute
  // Lattenkliever, 51.127125,3.368427"), and as "<name> (<lat>, <lon>)"
  // -- one Wayspot per line -- in another. Splits off whatever precedes
  // the first coordinate match on a single line and treats it as that
  // location's name. *** UNCONFIRMED beyond those samples *** -- can't
  // distinguish "a portal/Wayspot name" from e.g. a plain street address
  // with no name attached, so treat this as a starting point for manual
  // review in the exported CSV, not ground truth.
  const extractHelpshiftLocationName = (text) => {
    if (!text) return null;
    HELPSHIFT_COORD_RE.lastIndex = 0;
    const m = HELPSHIFT_COORD_RE.exec(text);
    if (!m) return text.trim() || null;
    const before = text.slice(0, m.index).replace(/[,\s(]+$/, "").trim();
    return before || null;
  };

  // Splits a block of text into individual "location list" lines, one
  // entry per line that contains a coordinate: "<name>, <lat>,<lng>" or
  // "<name> (<lat>, <lng>)" -- the two formats confirmed in real tickets
  // (single-location reports use the first; multi-location reports, and
  // reply messages that list further Wayspots, have used either). A line
  // with a coordinate but nothing recognizable before it still counts,
  // with name left null, rather than being dropped -- the coordinate
  // alone is still useful. A line with NO coordinate at all (a subheading
  // like "street signs:", ordinary prose in a reply) is skipped.
  //
  // Map/street-view links (a https://www.google.com/maps/place/.../@
  // <lat>,<lng>,... URL) are common in real replies as supplementary
  // evidence for a location just named a line or two above -- not a new
  // location by itself, but also not nothing: rather than drop it, it's
  // folded into that entry's `comment` field. Only a NAMED line becomes
  // the attachment target for a following link, so an unnamed bare
  // coordinate (usually itself a wrapped correction split onto its own
  // line, e.g. "Name, lat,lng (is actually here:\n<lat,lng>)") doesn't
  // steal a comment meant for the location actually named above it.
  //
  // BUGFIX (not upstream -- found via the same real ticket export as the
  // two fixes above, in a location list with an entry like "Kleurrijke
  // Handsculptuur (51.65..., 5.02...) (https://www.pol.nl/...)" -- a
  // coordinate AND a URL on the SAME line, both belonging to that one
  // entry): the original version checked for a URL first and, if found,
  // treated the ENTIRE line as a comment-for-the-previous-entry, never
  // even checking whether that same line also carried its own coordinate
  // -- silently dropping a real reported Wayspot and misattributing its
  // URL to an unrelated earlier one instead. Checking for a coordinate
  // FIRST (regardless of whether a URL is also present) fixes that: a
  // line's own coordinate always wins it a real entry, and any URL
  // trailing that SAME coordinate on the line becomes THIS entry's
  // comment rather than falling through to the "attach to `current`"
  // branch at all. The comment-on-a-later/prior line case this docblock
  // originally described (an unnamed follow-up line that's pure URL, no
  // coordinate of its own) still works exactly as before.
  const extractLocationLines = (text) => {
    const out = [];
    const lines = (text || "").split("\n");
    let current = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      HELPSHIFT_COORD_RE.lastIndex = 0;
      const m = HELPSHIFT_COORD_RE.exec(line);
      if (m) {
        // BUGFIX (not upstream): the text before the coordinate
        // match was used verbatim as `name`, with nothing filtering out a
        // URL if one happened to sit there instead of an actual name --
        // e.g. a "corrected location" line that's just a pasted map link
        // followed by the real coordinates, with no name of its own
        // ("https://maps.app.goo.gl/xyz 52.123, 4.456"). That produced a
        // location entry whose "name" was a raw URL rather than the null
        // that should mean "no name found" -- stripping any URL
        // substring out of the pre-coordinate text before using what's
        // left as the name fixes it (and still preserves a real name that
        // happens to have a link elsewhere on the same line, unlike just
        // discarding the whole name whenever a URL is present anywhere in
        // it).
        const namePart = line.slice(0, m.index)
          .replace(/https?:\/\/\S+/gi, "")
          .replace(/^[,\s()]+|[,\s(]+$/g, "")
          .trim();
        const name = namePart || null;
        const trailing = line.slice(m.index + m[0].length).replace(/^[\s),]+/, "").trim();
        const entry = { name, latitude: m[1], longitude: m[2], comment: /https?:\/\//i.test(trailing) ? trailing : null };
        out.push(entry);
        if (name) current = entry;
        continue;
      }
      if (/https?:\/\//i.test(line) && current) {
        current.comment = current.comment ? `${current.comment} ${line}` : line;
      }
    }
    return out;
  };

  // High-level convenience: given a classified ABUSE_REPORT_* email, pull
  // out the transcript, the reporter's original form fields, and every
  // Wayspot reported anywhere in the thread in one call. Thin wrapper --
  // see parseAbuseReportThread below for the actual extraction logic,
  // which operates on an already-parsed {conversationId, messages} rather
  // than a single raw email, specifically so a caller with messages
  // merged from SEVERAL emails (a long-running ticket that outgrew what
  // any one email export contains -- see mergeAbuseReportThreads) can run
  // the same logic on the complete picture.
  const parseAbuseReportEmail = (email) => {
    const plaintext = email.getBody("text/plain") || "";
    return parseAbuseReportThread(parseHelpshiftThread(plaintext));
  };

  const parseAbuseReportThread = ({ conversationId, messages }) => {
    // The reporter's form submission isn't necessarily message[1] -- longer
    // threads (support asking follow-up questions, the reporter replying
    // again) can push it further down, so find it by content instead of
    // position.
    const reportMsg = messages.find((msg) => /Reporting Abuse in (Wayfarer|Niantic Wayspot)/i.test(msg.raw));
    const { title, fields } = reportMsg ? extractHelpshiftFormFields(reportMsg.raw) : { title: null, fields: {} };

    const issueType = fields["What issue are you reporting?"] ?? null;
    const reportDetails = fields["Abuse report details"] ?? null;
    const locationDetails = fields["Provide details of the location(s)"] ?? null;

    // Every coordinate pair found across both fields, unfiltered/unnamed,
    // for anyone who wants to see everything the reporter mentioned
    // (a "corrected" location is sometimes buried in reportDetails prose --
    // see the note on `locations` below).
    const coordinates = extractHelpshiftCoordinates(
      [locationDetails, reportDetails].filter(Boolean).join("\n")
    );

    // One entry per reported Wayspot, deduped by coordinate (rounded to
    // 5dp -- ~1m -- so the same location quoted twice with slightly
    // different trailing digits still collapses to one row). Sourced
    // from:
    //   1. the original form's structured locationDetails field, split
    //      per line -- handles reports that list several Wayspots at
    //      once, not just one.
    //   2. every OTHER message in the thread (replies), scanned the same
    //      line-by-line way, so Wayspots added in a later reply ("I see I
    //      missed some: ...") are picked up too.
    // Deliberately NOT scanning reportDetails/"Abuse report details" --
    // that field is free prose, and can contain a *corrected* coordinate
    // for the same Wayspot already listed in locationDetails rather than
    // a distinct additional one (seen in a real ticket: "It is actually
    // located here: <lat,lng>" a few lines after the location(s) field).
    // Treating every number pair in there as a new location would
    // silently invent a duplicate row with a garbage name.
    const seen = new Set();
    const locations = [];
    const addLocation = (loc) => {
      const key = `${Number(loc.latitude).toFixed(5)},${Number(loc.longitude).toFixed(5)}`;
      if (seen.has(key)) return;
      seen.add(key);
      locations.push(loc);
    };
    extractLocationLines(locationDetails || "").forEach(addLocation);
    messages.forEach((msg) => {
      if (msg === reportMsg) return;
      extractLocationLines(stripHelpshiftMarkup(msg.raw))
        .filter((loc) => loc.name)
        .forEach(addLocation);
    });

    // Fallback for tickets that don't match either per-line format at
    // all: reuse the old single-best-guess logic (structured field first,
    // then whatever coordinate turns up in reportDetails prose) so this
    // doesn't regress on tickets the previous version already handled.
    if (locations.length === 0) {
      const fallbackName = extractHelpshiftLocationName(locationDetails);
      const locationCoords = extractHelpshiftCoordinates(locationDetails || "");
      const reportCoords = extractHelpshiftCoordinates(reportDetails || "");
      const fallbackCoord = locationCoords[0] || reportCoords[0] || null;
      if (fallbackCoord) locations.push({ name: fallbackName, latitude: fallbackCoord.latitude, longitude: fallbackCoord.longitude, comment: null });
    }

    // Back-compat single-value fields -- same meaning as before this
    // function returned a list, kept for any existing caller that only
    // wants "the" name/coordinate rather than all of them.
    const locationName = locations[0] ? locations[0].name : null;
    const primaryCoordinate = locations[0] ? { latitude: locations[0].latitude, longitude: locations[0].longitude } : null;

    return {
      conversationId,
      title,
      issueType,
      reportDetails,
      locationDetails,
      coordinates,
      locations,
      locationName,
      primaryCoordinate,
      messages,
    };
  };

const TEMPLATES = [
//  ---------------------------------------- MISCELLANEOUS ----------------------------------------
  {
    subject: /^Ingress Mission/,
    type: Type.MISCELLANEOUS,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Ingress Damage Report:/,
    type: Type.MISCELLANEOUS,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Help us improve Wayfarer$/,
    type: Type.SURVEY,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Help us tackle Wayfarer Abuse$/,
    type: Type.SURVEY,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Global Challenge Rewards$/,
    type: Type.CHALLENGE_REWARD,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Your Wayspot submission for/,
    type: Type.NOMINATION_DECIDED,
    style: Style.LIGHTSHIP,
    language: "en",
  },
  {
    subject: /Activated on VPS$/,
    type: Type.MISCELLANEOUS,
    style: Style.LIGHTSHIP,
    language: "en",
  },
  {
    subject: /^Re: \[\d+\] /,
    type: Type.MISCELLANEOUS,
    style: Style.UNKNOWN,
    language: "en",
  },
  //  ---------------------------------------- ENGLISH [en] ----------------------------------------
  {
    subject: /^Thanks! Niantic Spatial Wayspot nomination received for/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial Wayspot edit suggestion received for/,
    type: Type.EDIT_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Niantic Spatial Wayspot edit suggestion decided for/,
    type: Type.EDIT_DECIDED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial Wayspot Photo received for/,
    type: Type.PHOTO_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial Wayspot location edit appeal received for/,
    type: Type.EDIT_APPEAL_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial location report received for/,
    type: Type.REPORT_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Niantic Spatial location report decided for/,
    type: Type.REPORT_DECIDED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot nomination received for/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic Wayspot nomination decided for/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Decision on your? Wayfarer Nomination,/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot appeal received for/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Your Niantic Wayspot appeal has been decided for/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot (location|title|description) edit {2}appeal received for/,
    type: Type.EDIT_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Your Niantic Wayspot (location|title|description) edit appeal has been decided for/,
    type: Type.EDIT_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Portal submission confirmation:/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal review complete:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Ingress Portal Submitted:/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Ingress Portal Duplicate:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Ingress Portal Live:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Ingress Portal Rejected:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Thank You for Nominating a PokéStop for Review.$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Your PokéStop Nomination Is Eligible!$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Your PokéStop Nomination Is Ineligible$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Your PokéStop Nomination Review Is Complete:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Photo Submission Received$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Photo Submission (Accepted|Rejected)$/,
    type: Type.PHOTO_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Edit Suggestion Received$/,
    type: Type.EDIT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Edit Suggestion (Accepted|Rejected)$/,
    type: Type.EDIT_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Invalid Pokéstop\/Gym Report Received$/,
    type: Type.REPORT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Invalid Pokéstop\/Gym Report (Accepted|Rejected)$/,
    type: Type.REPORT_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot Photo received for/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic Wayspot media submission decided for/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot edit suggestion received for/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic Wayspot edit suggestion decided for/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic (Wayspot|location) report received for/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic (Wayspot|location) report decided for/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Portal photo submission confirmation/,
    type: Type.PHOTO_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal photo review complete/,
    type: Type.PHOTO_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal Edit Suggestion Received$/,
    type: Type.EDIT_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal edit submission confirmation/,
    type: Type.EDIT_RECEIVED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Portal edit review complete/,
    type: Type.EDIT_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Invalid Ingress Portal report received$/,
    type: Type.REPORT_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Invalid Ingress Portal report reviewed$/,
    type: Type.REPORT_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  //  ---------------------------------------- BENGALI [bn] ----------------------------------------
  {
    subject: /^ধন্যবাদ! .*-এর জন্য Niantic Wayspot মনোনয়ন পাওয়া গেছে!/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /-এর জন্য Niantic Wayspot মনোনয়নের সিদ্ধান্ত নেওয়া হয়েছে/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^ধন্যবাদ! .*( |-)এর জন্য Niantic Wayspot Photo পাওয়া গিয়েছে!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /-এর জন্য Niantic Wayspot মিডিয়া জমা দেওয়ার সিদ্ধান্ত নেওয়া হয়েছে$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^ধন্যবাদ! .*( |-)এর জন্য Niantic Wayspot সম্পাদনা করার পরামর্শ পাওয়া গেছে!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /-এর জন্য Niantic Wayspot সম্পাদনায় পরামর্শের সিদ্ধান্ত নেওয়া হয়েছে$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^ধন্যবাদ! .*( |-)এর জন্য Niantic Wayspot রিপোর্ট পাওয়া গেছে!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^Niantic Wayspot রিপোর্ট .*-এর জন্য সিদ্ধান্ত নেওয়া হয়েছে$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  //  ---------------------------------------- CZECH [cs] ----------------------------------------
  {
    subject: /^Děkujeme! Přijali jsme nominaci na Niantic Wayspot pro/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o nominaci na Niantic Wayspot pro/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme odvolání proti odmítnutí Niantic Wayspotu/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o odvolání proti nominaci na Niantic Wayspot pro/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme Photo pro Niantic Wayspot/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o odeslání obrázku Niantic Wayspotu/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme návrh na úpravu Niantic Wayspotu pro/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o návrhu úpravy Niantic Wayspotu pro/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme hlášení ohledně Niantic Wayspotu/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o hlášení v souvislosti s Niantic Wayspotem/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  //  ---------------------------------------- GERMAN [de] ----------------------------------------
  {
    subject: /^Danke! Wir haben deinen Vorschlag für den Wayspot/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zum Wayspot-Vorschlag/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben deinen Einspruch für den Wayspot/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zum Einspruch für den Wayspot/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Empfangsbestätigung deines eingereichten Portalvorschlags:/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Überprüfung des Portals abgeschlossen:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Trainer [^:]+: Danke, dass du einen PokéStop zur Überprüfung vorgeschlagen hast$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Trainer [^:]+: Dein vorgeschlagener PokéStop ist (zulässig!|nicht zulässig)$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Trainer [^:]+: Die Prüfung deines PokéStop-Vorschlags wurde abgeschlossen:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Fotovorschlag erhalten$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Fotovorschlag (akzeptiert|abgelehnt)$/,
    type: Type.PHOTO_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Vorschlag für Bearbeitung erhalten$/,
    type: Type.EDIT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Vorschlag für Bearbeitung (akzeptiert|abgelehnt)$/,
    type: Type.EDIT_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Meldung zu unzulässigen PokéStop\/Arena erhalten$/,
    type: Type.REPORT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Meldung zu unzulässigen PokéStop\/Arena (akzeptiert|abgelehnt)$/,
    type: Type.REPORT_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben den Upload Photo für den Wayspot/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zu deinem Upload für den Wayspot/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben deinen Änderungsvorschlag für den Wayspot/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zu deinem Änderungsvorschlag für den Wayspot/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben deine Meldung für den Wayspot/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zu deiner Meldung für den Wayspot/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Portalfotovorschlag erhalten/,
    type: Type.PHOTO_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Überprüfung des Portalfotos abgeschlossen/,
    type: Type.PHOTO_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Vorschlag für die Änderung eines Portals erhalten/,
    type: Type.EDIT_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Überprüfung des Vorschlags zur Änderung eines Portals abgeschlossen/,
    type: Type.EDIT_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Meldung zu ungültigem Ingress-Portal erhalten$/,
    type: Type.REPORT_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Meldung zu ungültigem Ingress-Portal geprüft$/,
    type: Type.REPORT_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  //  ---------------------------------------- SPANISH [es] ----------------------------------------
  {
    subject: /^¡Gracias! ¡Hemos recibido la propuesta de Wayspot de Niantic/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre la propuesta de Wayspot de Niantic/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Recurso de Wayspot de Niantic recibido para/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Hemos recibido el Photo del Wayspot de Niantic para/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre el envío de archivo de Wayspot de Niantic para/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Propuesta de modificación de Wayspot de Niantic recibida para/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre la propuesta de modificación del Wayspot de Niantic/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Hemos recibido el informe sobre el Wayspot de Niantic/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre el Wayspot de Niantic/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  //  ---------------------------------------- FRENCH [fr] ----------------------------------------
  {
    subject: /^Remerciements ! Proposition d’un Wayspot Niantic reçue pour/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant la proposition du Wayspot Niantic/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Remerciements ! Contribution de Wayspot Niantic Photo reçue pour/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant le Wayspot Niantic/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Remerciements ! Proposition de modification de Wayspot Niantic reçue pour/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant la modification du Wayspot Niantic/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Remerciements ! Signalement reçu pour le Wayspot/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant le signalement du Wayspot Niantic/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  //  ---------------------------------------- HINDI [hi] ----------------------------------------
  {
    subject: /^धन्यवाद! .* के लिए Niantic Wayspot नामांकन प्राप्त हुआ!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^Niantic Wayspot का नामांकन .* के लिए तय किया गया$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /के लिए तह Niantic Wayspot मीडिया सबमिशन$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^धन्यवाद! .* के लिए Niantic Wayspot Photo प्राप्त हुआ!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^धन्यवाद! .* के लिए Niantic Wayspot संपादन सुझाव प्राप्त हुआ!$/,
    disambiguate: (email) => {
      const doc = email.getDocument();
      const title = doc?.querySelector("td.em_pbottom.em_blue.em_font_20")?.textContent.trim();
      if (title == "बढ़िया खोज की! आपके वेस्पॉट Photo सबमिशन के लिए धन्यवाद!") {
        return {
          type: Type.PHOTO_RECEIVED,
          style: Style.WAYFARER,
          language: "hi",
        };
      } else if (title?.includes("आपके संपादन हमारे खोजकर्ताओं के समुदाय के लिए सर्वोत्तम संभव अनुभव बनाए रखने में मदद करते हैं।")) {
        return {
          type: Type.EDIT_RECEIVED,
          style: Style.WAYFARER,
          language: "hi",
        };
      } else {
        return null;
      }
    },
  },
  {
    subject: /के लिए Niantic Wayspot संपादन सुझाव प्राप्त हुआ$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^धन्यवाद! .* के लिए प्राप्त Niantic Wayspot रिपोर्ट!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /के लिए तय Niantic Wayspot रिपोर्ट$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  //  ---------------------------------------- ITALIAN [it] ----------------------------------------
  {
    subject: /^Grazie! Abbiamo ricevuto una candidatura di Niantic Wayspot per/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Proposta di Niantic Wayspot decisa per/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Grazie! Abbiamo ricevuto Photo di Niantic Wayspot per/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Proposta di contenuti multimediali di Niantic Wayspot decisa per/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Grazie! Abbiamo ricevuto il suggerimento di modifica di Niantic Wayspot per/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Suggerimento di modifica di Niantic Wayspot deciso per/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Grazie! Abbiamo ricevuto la segnalazione di Niantic Wayspot per/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Segnalazione di Niantic Wayspot decisa per/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  //  ---------------------------------------- JAPANESE [ja] ----------------------------------------
  {
    subject: /^ありがとうございます。 Niantic Wayspotの申請「.*」が受領されました。$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotの申請「.*」が決定しました。$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspotに関する申し立て「.*」が受領されました。$/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspot「.*」に関する申し立てが決定しました。$/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspot Photo「.*」が受領されました。$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotのメディア申請「.*」が決定しました。$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspot「.*」の編集提案が受領されました。$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotの編集提案「.*」が決定しました。$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspotに関する報告「.*」が受領されました。$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotの報告「.*」が決定しました$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  //  ---------------------------------------- KOREAN [ko] ----------------------------------------
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot 후보 신청이 완료되었습니다!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 후보 결정이 완료됨$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot Photo 제출 완료$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 미디어 제안 결정 완료$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot 수정이 제안되었습니다!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 수정 제안 결정 완료$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot 보고 접수$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 보고 결정 완료$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  //  ---------------------------------------- MARATHI [mr] ----------------------------------------
  {
    subject: /^धन्यवाद! Niantic वेस्पॉट नामांकन .* साठी प्राप्त झाले!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^Niantic वेस्पॉट नामांकन .* साठी निश्चित केले$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! Niantic वेस्पॉट आवाहन .* साठी प्राप्त झाले!$/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^तुमचे Niantic वेस्पॉट आवाहन .* साठी निश्चित करण्यात आले आहे$/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! .* साठी Niantic वेस्पॉट Photo प्राप्त झाले!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /साठी Niantic वेस्पॉट मीडिया सबमिशनचा निर्णय घेतला$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! Niantic वेस्पॉट संपादन सूचना .* साठी प्राप्त झाली!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^Niantic वेस्पॉट संपादन सूचना .* साठी निश्चित केली$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! .* साठी Niantic वेस्पॉट अहवाल प्राप्त झाला!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /साठी Niantic वेस्पॉट अहवाल निश्चित केला$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  //  ---------------------------------------- DUTCH [nl] ----------------------------------------
  {
    subject: /^Bedankt! Niantic Wayspot-nominatie ontvangen voor/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-nominatie voor/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Bedankt! Niantic Wayspot-Photo ontvangen voor/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-media-inzending voor/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Bedankt! Niantic Wayspot-bewerksuggestie ontvangen voor/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-bewerksuggestie voor/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Bedankt! Melding van Niantic Wayspot .* ontvangen!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-melding voor/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  //  ---------------------------------------- NORWEGIAN [no] ----------------------------------------
  {
    subject: /^Takk! Vi har mottatt Niantic Wayspot-nominasjonen for/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-nominasjonen for/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt Niantic Wayspot-klagen for/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-klagen for/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt Photo for Niantic-Wayspot-en/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt endringsforslaget for Niantic Wayspot-en/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt Niantic Wayspot-rapporten for/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-medieinnholdet som er sendt inn for/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for endringsforslaget for Niantic Wayspot-en/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-rapporten for/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  //  ---------------------------------------- POLISH [pl] ----------------------------------------
  {
    subject: /^Dziękujemy! Odebrano nominację Wayspotu/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Podjęto decyzję na temat nominacji Wayspotu/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Dziękujemy! Odebrano materiały Photo Wayspotu Niantic/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Decyzja na temat zgłoszenia materiałów do Wayspotu Niantic/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Dziękujemy! Odebrano sugestię zmiany Wayspotu Niantic/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Podjęto decyzję na temat sugestii edycji Wayspotu Niantic/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Dziękujemy! Odebrano raport dotyczący Wayspotu Niantic/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Podjęto decyzję odnośnie raportu dotyczącego Wayspotu Niantic/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  //  ---------------------------------------- PORTUGUESE [pt] ----------------------------------------
  {
    subject: /^Agradecemos a sua indicação para o Niantic Wayspot/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre a indicação do Niantic Wayspot/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Agradecemos o envio de Photo para o Niantic Wayspot/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre o envio de mídia para o Niantic Wayspot/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Agradecemos a sua sugestão de edição para o Niantic Wayspot/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre a sugestão de edição do Niantic Wayspot/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Agradecemos o envio da denúncia referente ao Niantic Wayspot/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre a denúncia referente ao Niantic Wayspot/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  //  ---------------------------------------- RUSSIAN [ru] ----------------------------------------
  {
    subject: /^Спасибо! Номинация Niantic Wayspot для .* получена!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по номинации Niantic Wayspot для/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Спасибо! Получено: Photo Niantic Wayspot для/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по предложению по файлу для/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Спасибо! Предложение по изменению Niantic Wayspot для/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по предложению по изменению Niantic Wayspot для/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Спасибо! Жалоба на Niantic Wayspot для/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по жалобе на Niantic Wayspot для/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  //  ---------------------------------------- SWEDISH [sv] ----------------------------------------
  {
    subject: /^Tack! Niantic Wayspot-nominering har tagits emot för/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-nominering har beslutats om för/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Din Niantic Wayspot-överklagan har beslutats om för/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Tack! Niantic Wayspot Photo togs emot för/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-medieinlämning har beslutats om för/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Tack! Niantic Wayspot-redigeringsförslag har tagits emot för/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-redigeringsförslag har beslutats om för/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Tack! Niantic Wayspot-rapport har tagits emot för/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-rapport har beslutats om för/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  //  ---------------------------------------- TAMIL [ta] ----------------------------------------
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot பரிந்துரை பெறப்பட்டது!!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot பணிந்துரை பரிசீலிக்கப்பட்டது.$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot Photo பெறப்பட்டது!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot மீடியா சமர்ப்பிப்பு பரிசீலிக்கப்பட்டது.$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot திருத்த பரிந்துரை பெறப்பட்டது!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot திருத்த பரிந்துரை பரிசீலிக்கப்பட்டது$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot புகார் பெறப்பட்டது!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot புகார் பரிசீலிக்கப்பட்டது!$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  //  ---------------------------------------- TELUGU [te] ----------------------------------------
  {
    subject: /^ధన్యవాదాలు! .* కు Niantic Wayspot నామినేషన్ అందుకున్నాము!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు Niantic వేస్పాట్ నామినేషన్‌‌పై నిర్ణయం$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /^ధన్యవాదాలు! .* కొరకు Niantic Wayspot Photo అందుకున్నాము!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు Niantic వేస్పాట్ మీడియా సమర్పణపై నిర్ణయం$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /^ధన్యవాదాలు! మీ వేస్పాట్ .* ఎడిట్ సూచనకై ధన్యవాదాలు!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు నిర్ణయించబడిన Niantic వేస్పాట్ సూచన$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /^ధన్యవాదాలు! .* కొరకు Niantic వేస్పాట్ నామినేషన్ అందుకున్నాము!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు నిర్ణయించబడిన Niantic వేస్పాట్ రిపోర్ట్$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  //  ---------------------------------------- THAI [th] ----------------------------------------
  {
    subject: /^ขอบคุณ! เราได้รับการเสนอสถานที่ Niantic Wayspot สำหรับ/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลการตัดสินการเสนอสถานที่ Niantic Wayspot สำหรับ/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ขอบคุณ! ได้รับ Niantic Wayspot Photo สำหรับ/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลการตัดสินการส่งมีเดีย Niantic Wayspot สำหรับ/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ขอบคุณ! เราได้รับคำแนะนำการแก้ไข Niantic Wayspot สำหรับ/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลการตัดสินคำแนะนำการแก้ไข Niantic Wayspot สำหรับ/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ขอบคุณ! เราได้รับการรายงาน Niantic Wayspot สำหรับ/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลตัดสินการรายงาน Niantic Wayspot สำหรับ/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  //  ---------------------------------------- CHINESE [zh] ----------------------------------------
  {
    subject: /^感謝你！ 我們已收到 Niantic Wayspot 候選/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^社群已對 Niantic Wayspot 候選 .* 做出決定$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^感謝你！ 我們已收到 .* 的 Niantic Wayspot Photo！$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^社群已對你為 .* 提交的 Niantic Wayspot 媒體做出決定$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^感謝你！ 我們已收到 .* 的 Niantic Wayspot 編輯建議！$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^社群已對 .* 的 Niantic Wayspot 編輯建議做出決定$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^感謝你！ 我們已收到 .* 的 Niantic Wayspot 報告！$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^Niantic 已對 .* 的 Wayspot 報告做出決定$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
];

  // -------------------------------------------------------------------------
  // SUPPLEMENTAL TEMPLATES -- not from upstream OPR-Tools.
  //
  // The upstream templates.ts (ported above, unmodified) has no RECON-style
  // (current "Spatial" era) templates for: nomination decisions, photo
  // decisions, or Spatial-branded appeal emails. Your gmail_wayspot_export.py
  // had already reverse-engineered these from real inbox testing, so they're
  // carried over here rather than silently losing decision-matching for
  // every current-era submission. Each entry below is commented with where
  // it came from.
  // -------------------------------------------------------------------------
  const SUPPLEMENTAL_TEMPLATES = [
    // Confirmed real subject (gmail_wayspot_export.py NOMINATION_DECIDED_QUERY)
    {
      subject: /^Niantic Spatial Wayspot nomination decided for/,
      type: Type.NOMINATION_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py NOMINATION_DECIDED_QUERY,
    // note: "Decision on you Recon Nomination" -- "you" not "your", as observed)
    {
      subject: /^Decision on you Recon Nomination,/,
      type: Type.NOMINATION_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py PHOTO_DECIDED_QUERY)
    {
      subject: /media submission decided for/i,
      type: Type.PHOTO_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py APPEAL_RECEIVED_QUERY).
    // Spatial-branded nomination/photo appeal -- which of the two it targets
    // is only knowable from the body, so classification alone can't tell;
    // wst-business-logic.js resolves the real target via parseAppealReceived().
    {
      subject: /^Thanks! Niantic Spatial Wayspot appeal received/,
      type: Type.NOMINATION_APPEAL_RECEIVED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py APPEAL_EDIT_RECEIVED_QUERY)
    {
      subject: /^Thanks! Niantic Spatial Wayspot title edit appeal received for/,
      type: Type.EDIT_APPEAL_RECEIVED,
      style: Style.RECON,
      language: "en",
    },
    // *** BEST-EFFORT / UNCONFIRMED ***
    // gmail_wayspot_export.py's own docstring flags this as a guessed subject
    // line -- no real example existed when it was written. Carried over
    // as-is, same caveat applies here.
    {
      subject: /^Your Niantic Spatial Wayspot appeal has been decided/,
      type: Type.NOMINATION_APPEAL_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subjects (Dutch legacy Wayfarer) -- found via a real
    // user inbox. Upstream's Dutch templates cover received/decided for
    // nominations/photos/edits/reports, but have no appeal templates at
    // all, and the one Dutch NOMINATION_DECIDED template upstream does have
    // ("Besluit over Niantic Wayspot-nominatie voor...") doesn't match this
    // wording -- these appear to be a different/older subject-line
    // generation than what upstream's template was modeled on.
    {
      subject: /^Beslissing over je Wayfarer-nominatie,/,
      type: Type.NOMINATION_DECIDED,
      style: Style.WAYFARER,
      language: "nl",
    },
    {
      subject: /^Bedankt! Niantic Wayspot-bezwaar ontvangen voor/,
      type: Type.NOMINATION_APPEAL_RECEIVED,
      style: Style.WAYFARER,
      language: "nl",
    },
    {
      subject: /^Niantic heeft een besluit genomen over je bezwaar voor/,
      type: Type.NOMINATION_APPEAL_DECIDED,
      style: Style.WAYFARER,
      language: "nl",
    },
  ];

  TEMPLATES.push(...SUPPLEMENTAL_TEMPLATES);

  // -------------------------------------------------------------------------
  // HELPSHIFT TEMPLATES -- non-upstream, see the "helpshift.ts" section
  // above. Confirmed real subject: "Re: [43118150] Reporting Abuse in
  // Wayfarer" (Niantic Support's auto-acknowledgement reply). The
  // no-"Re:"-prefix case (presumably the original ticket-opened email) is
  // *** UNCONFIRMED *** -- included on the assumption Helpshift reuses the
  // same subject minus "Re: " for the first message, but no real example
  // was available to check this against.
  //
  // This must be checked *before* the upstream catch-all
  // /^Re: \[\d+\] / -> MISCELLANEOUS/UNKNOWN rule a few hundred lines up,
  // which would otherwise swallow every reply in this thread first (array
  // order is match-priority order in classify()). Prepending via unshift
  // -- rather than TEMPLATES.push(), like SUPPLEMENTAL_TEMPLATES above --
  // guarantees that regardless of where in the upstream-ported array a
  // future addition might slot in.
  // -------------------------------------------------------------------------
  // Niantic Support closes an abuse-report ticket with one of three
  // canned replies -- confirmed real text for all three:
  //   ACTIONED: "We have reviewed the report and have taken action
  //     on the Wayspots in accordance with our policies."
  //   PENDING: "Thank you for your patience as your report is being
  //     looked into. We will follow up once we have reviewed the
  //     reported Wayspots."
  //   DENIED: "We took another look at the Wayspot in question and
  //     decided that it does not meet our criteria for removal at
  //     this time."
  // Matched against whitespace-normalized text (a canned phrase can
  // be word-wrapped across lines in the raw email) so wrapping
  // doesn't break the match. This replaces an earlier *** BEST-
  // EFFORT / UNCONFIRMED *** version that guessed generic support-
  // ticket vocabulary ("resolved", "closing this ticket", etc.)
  // because no real resolved/closed example was available when it
  // was written -- keep that history in mind if a *fourth* canned
  // reply ever turns up that doesn't match any of these three.
  //
  // Takes a `messages` array directly (newest-first -- see
  // parseHelpshiftThread) rather than an Email, so it works the same way
  // whether `messages` came from a single email's own thread or several
  // emails merged together (see mergeAbuseReportThreads) -- a
  // long-running ticket's true newest message might live in a LATER
  // email export than whichever one happens to be classified, so status
  // needs to be computed from the merged view too, not just one email.
  const classifyAbuseReportStatus = (messages) => {
    if (!messages.length) return null;

    // Confirmed real example: the transcript lists the newest message
    // FIRST (standard quoted-reply convention -- newest on top, older
    // context quoted below), not chronologically. In the one confirmed
    // sample this is "Niantic Support"'s immediate auto-acknowledgement,
    // with the reporter's own original form submission quoted below it
    // at the same timestamp.
    const newest = messages[0];
    const newestText = stripHelpshiftMarkup(newest.raw).toLowerCase();
    // NOT author.includes("niantic support") -- that only matches the
    // automated acknowledgement. A real human agent's reply (including
    // the actual decision messages this exists to classify) is
    // authored under their own name ("Jaxson", "Graham", ...), never
    // the literal "Niantic Support" string. The reliable signal
    // (confirmed against real tickets while tracking down the
    // blank-author header-parsing bug elsewhere in this file) is that
    // the REPORTER's own messages have a blank author -- Helpshift
    // doesn't render a name for the ticket owner -- while every
    // Niantic-side reply, bot or named human, has a non-blank one.
    const newestIsSupport = newest.author.trim() !== "";

    const isAutoAck = newestIsSupport
      && /thank you for contacting/.test(newestText)
      && /back to you shortly/.test(newestText);

    const newestNormalized = newestText.replace(/\s+/g, " ").trim();
    const looksActioned = newestIsSupport && /we have reviewed the report and have taken action on the wayspots? in accordance with our policies/.test(newestNormalized);
    const looksPending = newestIsSupport && /thank you for your patience as your report is being looked into\.? we will follow up once we have reviewed the reported wayspots?/.test(newestNormalized);
    const looksDenied = newestIsSupport && /we took another look at the wayspot in question and decided that it does not meet our criteria for removal at this time/.test(newestNormalized);

    if (isAutoAck) return Type.ABUSE_REPORT_RECEIVED;
    if (looksActioned) return Type.ABUSE_REPORT_ACTIONED;
    if (looksPending) return Type.ABUSE_REPORT_PENDING;
    if (looksDenied) return Type.ABUSE_REPORT_DENIED;
    return Type.ABUSE_REPORT_UPDATED;
  };

  // Merges the message lists from several parsed threads that share the
  // same conversationId -- needed because a long-running ticket generates
  // a new email notification on every reply, and each individual email
  // export only contains THAT email's own quoted-history window, not
  // necessarily every message that's ever been part of the conversation
  // (confirmed against two real exports of the same ticket, a week apart:
  // the earlier one's original form-submission message, with its
  // structured fields, wasn't present at all in the later one's quoted
  // history -- scanning either alone misses real data the other has).
  // Dedupes by (author, date, time, raw) -- the exact same message
  // appears byte-for-byte identical across every export that happens to
  // include it, via standard email quoting -- and re-sorts the union
  // newest-first by actual parsed timestamp, since simple concatenation
  // can't be trusted to preserve a correct global order across messages
  // that originally came from different emails' own (locally newest-
  // first) orderings.
  const mergeThreads = (threads) => {
    const conversationId = threads.map((t) => t.conversationId).find(Boolean) || null;
    const seen = new Set();
    const merged = [];
    for (const { messages } of threads) {
      for (const msg of messages) {
        const key = `${msg.author}|${msg.date}|${msg.time}|${msg.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(msg);
      }
    }
    merged.sort((a, b) => {
      const ta = Date.parse(`${a.date} ${a.time}`);
      const tb = Date.parse(`${b.date} ${b.time}`);
      // Newest first, matching a single thread's own convention. An
      // unparseable timestamp sorts last rather than crashing the sort
      // or silently reshuffling everything around it.
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });
    return { conversationId, messages: merged };
  };

  const HELPSHIFT_TEMPLATES = [
    {
      subject: /^(?:Re: )?\[\d+\]\s*Reporting Abuse in (?:Wayfarer|Niantic Wayspot)/i,
      disambiguate: (email) => {
        const plaintext = email.getBody("text/plain") || "";
        const { messages } = parseHelpshiftThread(plaintext);
        const type = classifyAbuseReportStatus(messages);
        if (type === null) return null;
        return { type, style: Style.SUPPORT, language: "en" };
      },
    },
  ];
  TEMPLATES.unshift(...HELPSHIFT_TEMPLATES);

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  global.OPREmail = {
    Type,
    Style,
    Email,
    parseMIME,
    extractEmail,
    decodeBodyUsingCTE,
    stripDiacritics,
    TEMPLATES,
    // non-upstream: see the "helpshift.ts" section
    helpshift: {
      parseThread: parseHelpshiftThread,
      stripMarkup: stripHelpshiftMarkup,
      extractFormFields: extractHelpshiftFormFields,
      extractCoordinates: extractHelpshiftCoordinates,
      parseAbuseReportEmail,
      parseAbuseReportThread,
      classifyAbuseReportStatus,
      mergeThreads,
    },
    errors: {
      InvalidEmailFormatError,
      NotImplementedError,
      InvalidContentTypeError,
      HeaderNotFoundError,
      NoMatchingTemplateError,
      DisambiguationFailedError,
    },
  };
})(window);
