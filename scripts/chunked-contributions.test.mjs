import assert from "node:assert/strict";
import test from "node:test";

import { createChunkedContributionFetch } from "./chunked-contributions.mjs";

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

test("splits a resource-limited contribution range and recombines the days", async () => {
  const ranges = [];
  const upstreamFetch = async (_input, init) => {
    const { variables } = JSON.parse(init.body);
    ranges.push([variables.from, variables.to]);

    const from = variables.from.slice(0, 10);
    const to = variables.to.slice(0, 10);
    if (from !== to) {
      return jsonResponse({
        data: { user: null },
        errors: [
          {
            type: "RESOURCE_LIMITS_EXCEEDED",
            message: "Resource limits for this query exceeded.",
          },
        ],
      });
    }

    const weekday = new Date(`${from}T00:00:00Z`).getUTCDay();
    return jsonResponse({
      data: {
        user: {
          contributionsCollection: {
            contributionCalendar: {
              weeks: [
                {
                  contributionDays: [
                    {
                      contributionCount: 1,
                      contributionLevel: "FIRST_QUARTILE",
                      weekday,
                      date: from,
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  };

  const patchedFetch = createChunkedContributionFetch({
    fetch: upstreamFetch,
    now: new Date("2026-07-13T12:00:00Z"),
    weeks: 0,
    chunkDays: 31,
  });

  const response = await patchedFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: "bearer test" },
    body: JSON.stringify({
      query:
        "query ($login: String!) { user(login: $login) { contributionsCollection { contributionCalendar { weeks { contributionDays { date } } } } } }",
      variables: { login: "No898" },
    }),
  });
  const result = await response.json();
  const days =
    result.data.user.contributionsCollection.contributionCalendar.weeks.flatMap(
      (week) => week.contributionDays,
    );

  assert.deepEqual(
    days.map((day) => day.date),
    ["2026-07-12", "2026-07-13"],
  );
  assert.equal(ranges.length, 3);
});

test("delegates unrelated requests without changing them", async () => {
  const expected = jsonResponse({ ok: true });
  let received;
  const upstreamFetch = async (...args) => {
    received = args;
    return expected;
  };
  const patchedFetch = createChunkedContributionFetch({
    fetch: upstreamFetch,
    now: new Date("2026-07-13T12:00:00Z"),
  });
  const init = { headers: { accept: "application/json" } };

  const actual = await patchedFetch("https://example.com/data", init);

  assert.equal(actual, expected);
  assert.deepEqual(received, ["https://example.com/data", init]);
});
