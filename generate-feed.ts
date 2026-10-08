#!/usr/bin/env node
import { execFileSync } from "child_process";

function escape(str: string): string {
  const entities: Record<string, string> = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  };
  return str.replace(/[<>&'"]/g, (c) => entities[c]);
}

interface LocalizedString {
  [locale: string]: string;
}

interface LocalizedStrings {
  [key: string]: LocalizedString;
}

function renderHTML(data: LocalizedStrings): string {
  const cellStyle = 'border: 1px solid;';
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return "<p>N/A</p>";
  }

  const rowsHtml = entries
    .map(([key, locales]) => {
      const localeEntries = Object.entries(locales);

      return localeEntries
        .map(([locale, value], index) => {
          const keyCell =
            index === 0
              ? `\n      <td rowspan="${localeEntries.length}" style="${cellStyle}">${escape(key)}</td>`
              : "";

          return `    <tr>${keyCell}
      <td style="${cellStyle}">${escape(locale)}</td>
      <td style="${cellStyle}">${escape(value)}</td>
    </tr>`;
        })
        .join("\n");
    })
    .join("\n");

  return `<table>
  <thead>
    <tr>
      <th style="${cellStyle}">Key</th>
      <th style="${cellStyle}">Locale</th>
      <th style="${cellStyle}">Value</th>
    </tr>
  </thead>
  <tbody>
${rowsHtml}
  </tbody>
</table>`;
}

interface Entry {
  sha: string;
  date: string;
  content: string;
  contentUrl: string;
}

function main(): void {
  const title = "DeepSeek Notification";
  const githubServer = process.env.GITHUB_SERVER_URL || "https://github.com";
  const githubRepo = process.env.GITHUB_REPOSITORY || "zhangyoufu/DeepSeek-Notification";
  const feedUrl = process.env.FEED_URL || "https://zhangyoufu.github.io/DeepSeek-Notification/atom.xml";
  const websubHubUrl = process.env.WEBSUB_HUB_URL || "https://pubsubhubbub.superfeedr.com/";
  const repoUrl = `${githubServer}/${githubRepo}`;
  const MAX_ENTRIES = 5;

  const log = execFileSync(
    "git",
    ["log", "--format=%H %cd", "--date=iso-strict", "-n", String(MAX_ENTRIES), "--", "output.json"],
    { encoding: "utf-8" }
  ).trim();

  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(" ", 2) as [string, string]);

  const entries: Entry[] = commits.map(([sha, date]) => {
    const content = execFileSync("git", ["show", `${sha}:output.json`], {
      encoding: "utf-8",
    }).trim();
    const contentUrl = `${repoUrl}/blob/${sha}/output.json`;
    return { sha, date, content, contentUrl };
  });

  // build Atom entries XML
  const entryXmls = entries
    .map(
      ({ sha, date, content, contentUrl }) => `
  <entry>
    <title>${title}</title>
    <link href="${contentUrl}" />
    <id>${sha}</id>
    <updated>${date}</updated>
    <content type="html">
${escape(renderHTML(JSON.parse(content)))}
    </content>
  </entry>`
    )
    .join("");

  // generate Atom feed
  console.log(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${title}</title>
  <subtitle>Tracking DeepSeek platform announcements</subtitle>
  <id>${repoUrl}</id>
  <link href="${repoUrl}" />
  <link rel="self" href="${feedUrl}" />
  <link rel="hub" href="${websubHubUrl}" />
  <updated>${new Date().toISOString()}</updated>
  <author>
    <name>bot</name>
    <uri>${repoUrl}</uri>
  </author>${entryXmls}
</feed>`);
};

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
