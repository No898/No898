const GRAPHQL_URL = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;

const query = `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks {
            contributionDays {
              contributionCount
              contributionLevel
              weekday
              date
            }
          }
        }
      }
    }
  }
`;

const startOfUtcDay = (value) =>
  new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
    ),
  );

const addDays = (value, days) => new Date(value.getTime() + days * DAY_MS);
const dateOnly = (value) => value.toISOString().slice(0, 10);
const rangeSize = (from, to) =>
  Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;

const isResourceLimit = (payload) =>
  payload.errors?.some(
    (error) => error.type === "RESOURCE_LIMITS_EXCEEDED",
  );

const requestRange = async ({
  fetch,
  url,
  headers,
  signal,
  login,
  from,
  to,
}) => {
  const response = await fetch(url, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      query,
      variables: {
        login,
        from: `${dateOnly(from)}T00:00:00Z`,
        to: `${dateOnly(to)}T23:59:59Z`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL returned ${response.status}: ${await response.text()}`,
    );
  }

  const payload = await response.json();
  if (isResourceLimit(payload)) {
    if (rangeSize(from, to) === 1) {
      throw new Error(`GitHub resource limit exceeded for ${dateOnly(from)}`);
    }

    const leftSize = Math.ceil(rangeSize(from, to) / 2);
    const middle = addDays(from, leftSize - 1);
    return [
      ...(await requestRange({
        fetch,
        url,
        headers,
        signal,
        login,
        from,
        to: middle,
      })),
      ...(await requestRange({
        fetch,
        url,
        headers,
        signal,
        login,
        from: addDays(middle, 1),
        to,
      })),
    ];
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors[0].message);
  }

  const weeks =
    payload.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!weeks) {
    throw new Error(`GitHub returned no contribution calendar for ${login}`);
  }

  return weeks.flatMap((week) => week.contributionDays);
};

const groupIntoWeeks = (days) => {
  const uniqueDays = new Map(days.map((day) => [day.date, day]));
  const weeks = new Map();

  for (const day of [...uniqueDays.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  )) {
    const date = new Date(`${day.date}T00:00:00Z`);
    const week = dateOnly(addDays(date, -date.getUTCDay()));
    const contributionDays = weeks.get(week) ?? [];
    contributionDays.push(day);
    weeks.set(week, contributionDays);
  }

  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, contributionDays]) => ({ contributionDays }));
};

export const createChunkedContributionFetch = ({
  fetch,
  now = new Date(),
  weeks = 52,
  chunkDays = 31,
}) => {
  if (typeof fetch !== "function") throw new TypeError("fetch is required");

  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init?.body;
    if (url !== GRAPHQL_URL || typeof body !== "string") {
      return fetch(input, init);
    }

    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return fetch(input, init);
    }

    const login = request.variables?.login;
    if (
      typeof login !== "string" ||
      !request.query?.includes("contributionsCollection")
    ) {
      return fetch(input, init);
    }

    const end = startOfUtcDay(now);
    const start = addDays(end, -end.getUTCDay() - weeks * 7);
    const days = [];

    for (let from = start; from <= end; from = addDays(from, chunkDays)) {
      const to = new Date(
        Math.min(addDays(from, chunkDays - 1).getTime(), end.getTime()),
      );
      days.push(
        ...(await requestRange({
          fetch,
          url,
          headers: init.headers,
          signal: init.signal,
          login,
          from,
          to,
        })),
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: { weeks: groupIntoWeeks(days) },
            },
          },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
};
