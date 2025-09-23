#!/usr/bin/env node

/**
 * CI Domain Checker (Synchronous-style logging)
 *
 * Features:
 *  - DNS resolution
 *  - HTTP/HTTPS accessibility
 *  - SSL/TLS validation
 *  - Redirect loop detection
 *  - Timeout handling
 *  - Placeholder / parked page detection
 *  - Cloudflare / WAF / 5xx error detection
 *  - Blank or JS-only page detection
 *  - Debug logging for GitHub Actions
 */

import { extractDomainsFromJSDoc } from "../build/jsdoc.js";
import { deduplicateRootDomains } from "../build/domain.js";
import dns from "dns/promises";
import http from "http";
import https from "https";
import { URL } from "url";

/* ------------------------ CONFIG ------------------------ */

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 10000;
const DEBUG = true; // toggle debug messages

const PLACEHOLDER_PATTERNS = [
  "Welcome to nginx!",
  "This domain is parked",
  "Buy this domain",
  "Domain for sale",
  "Default PLESK Page",
];

const WAF_PATTERNS = [
  "Attention Required! | Cloudflare",
  "Checking your browser before accessing",
  "DDOS protection by",
];

const ERROR_PAGE_PATTERNS = [
  "Error 521",
  "Error 522",
  "Error 523",
  "Error 524",
  "Error 525",
  "Service Temporarily Unavailable",
];

const STATUS_ICONS = {
  VALID: "✅",
  PLACEHOLDER: "⚠️",
  EMPTY_PAGE: "📄",
  JS_ONLY: "📜",
  CLIENT_ERROR: "🚫",
  SERVER_ERROR: "🔥",
  INVALID_SSL: "🔒",
  EXPIRED: "❌",
  UNREACHABLE: "🌐",
  REFUSED: "⛔",
  TIMEOUT: "⏱️",
  REDIRECT_LOOP: "🔁",
  PROTECTED: "🛡️",
  UNKNOWN: "❓",
};

/* ------------------------ DEBUG HELPER ------------------------ */

function debugLog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

/* ------------------------ UTILITIES ------------------------ */

/** Check if a domain is resolvable via DNS (IPv4/IPv6) */
async function isDomainResolvable(domain) {
  try {
    await dns.resolve4(domain);
    debugLog(domain, "DNS resolved via A record");
    return true;
  } catch {
    try {
      await dns.resolve6(domain);
      debugLog(domain, "DNS resolved via AAAA record");
      return true;
    } catch {
      debugLog(domain, "DNS NOT resolved");
      return false;
    }
  }
}

/** Fetch a URL with timeout and return status, headers, and body */
async function fetchUrl(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  debugLog("Fetching", url);
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === "https:" ? https : http;

    const timer = setTimeout(() => {
      debugLog("Timeout fetching", url);
      resolve({ status: "TIMEOUT" });
    }, timeoutMs);

    const req = client.get(urlObj, (res) => {
      clearTimeout(timer);
      let body = "";
      res.on("data", (chunk) => {
        if (body.length < 8192) body += chunk.toString();
      });
      res.on("end", () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body })
      );
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      debugLog("Request error for", url, err.code);
      if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"].includes(err.code))
        resolve({ status: "REFUSED" });
      else if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(err.code))
        resolve({ status: "INVALID_SSL" });
      else resolve({ status: "UNREACHABLE" });
    });
  });
}

/** Determine if a page is blank or only contains JavaScript */
function isEmptyOrJsOnly(body) {
  if (!body) return "EMPTY_PAGE";

  const stripped = body
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/\s/g, "");

  const scriptMatches = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  const scriptContent = scriptMatches.map((m) => m[1]).join("").trim();

  if (stripped === "" && scriptContent) return "JS_ONLY";
  return stripped.length === 0 ? "EMPTY_PAGE" : false;
}

/* ------------------------ DOMAIN CHECK ------------------------ */

/** Check if a domain is accessible and determine status */
async function checkDomainStatus(domain) {
  const protocols = ["https", "http"];

  for (const protocol of protocols) {
    try {
      let url = `${protocol}://${domain}`;
      const visited = new Set();
      let redirects = 0;

      while (redirects < MAX_REDIRECTS) {
        if (visited.has(url)) return "REDIRECT_LOOP";
        visited.add(url);

        const { status, statusCode, headers, body } = await fetchUrl(url);

        if (status) {
          debugLog(domain, "Low-level status:", status);
          return status;
        }

        // Handle redirects
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          url = new URL(headers.location, url).toString();
          redirects++;
          debugLog(domain, "Redirect to", url);
          continue;
        }

        // HTTP errors
        if (statusCode >= 500) {
          debugLog(domain, "Server error", statusCode);
          return `SERVER_ERROR_${statusCode}`;
        }
        if (statusCode >= 400) {
          debugLog(domain, "Client error", statusCode);
          return `CLIENT_ERROR_${statusCode}`;
        }

        if (body) {
          // Detect Cloudflare 5xx / WAF
          for (const code of ["521","522","523","524","525"]) {
            if (body.includes(`Error ${code}`)) {
              debugLog(domain, "Cloudflare error detected:", code);
              return `CLOUDFLARE_${code}`;
            }
          }

          if (body.includes("Cloudflare Ray ID") || WAF_PATTERNS.some((p) => body.includes(p))) {
            debugLog(domain, "Protected by WAF");
            return "PROTECTED";
          }

          // Detect placeholder / blank / JS-only
          const emptyCheck = isEmptyOrJsOnly(body);
          if (emptyCheck) {
            debugLog(domain, "Empty/JS-only page detected:", emptyCheck);
            return emptyCheck;
          }

          if (PLACEHOLDER_PATTERNS.some((p) => body.includes(p))) {
            debugLog(domain, "Placeholder page detected");
            return "PLACEHOLDER";
          }
        }

        return "VALID";
      }

      return "REDIRECT_LOOP";
    } catch (err) {
      debugLog(domain, "Error in checkDomainStatus", err.message);
      continue;
    }
  }

  return "UNREACHABLE";
}

/** Main wrapper with DNS resolution */
async function checkDomain(domain) {
  const resolvable = await isDomainResolvable(domain);
  if (!resolvable)
    return { domain, status: "EXPIRED", resolvable: false, accessible: false };

  const status = await checkDomainStatus(domain);
  return { domain, status, resolvable: true, accessible: status === "VALID" };
}

/* ------------------------ MAIN ------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const categories = args.length ? args : null;

  console.log("Extracting domains from sites directory...");
  console.log(`Categories: ${categories ? categories.join(", ") : "all"}`);

  const domains = await extractDomainsFromJSDoc(categories);
  const uniqueDomains = deduplicateRootDomains(domains);

  console.log(`Found ${uniqueDomains.length} unique domains\n`);
  if (!uniqueDomains.length) return console.log("No domains found.");

  const results = [];
  for (const domain of uniqueDomains) {
    process.stdout.write(`Checking ${domain}... `);
    const result = await checkDomain(domain);
    results.push(result);
    const icon = STATUS_ICONS[result.status] || "❓";
    console.log(`${icon} ${result.status}`);
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("SUMMARY:");
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  Object.keys(STATUS_ICONS).forEach((status) => {
    if (counts[status]) console.log(`${STATUS_ICONS[status]} ${status}: ${counts[status]}`);
  });

  console.log(`📊 Total: ${results.length}`);

  const problematic = results.filter((r) => r.status !== "VALID");
  problematic.forEach((r) => {
    console.log(`${STATUS_ICONS[r.status] || "❓"} ${r.status} -> ${r.domain}`);
  });

  console.log(
    problematic.length
      ? `\n⚠️ Found ${problematic.length} problematic domain(s)`
      : "\n✅ All domains are valid!"
  );
}

main().catch(console.error);
