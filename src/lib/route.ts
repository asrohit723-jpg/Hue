import { useEffect, useState } from 'react';

/**
 * Where you are, in the URL.
 *
 * The screen used to live in React state, so a reload always landed on
 * Overview — you lost the call you were reading, and a link to it could not be
 * sent to anyone. The URL is the only place this can live and survive both.
 *
 * HASH, not path. This app deploys as a static bundle: there is no server to
 * rewrite /calls/L-2431 back to index.html, so a real path would 404 on the
 * very reload it is meant to survive. A hash never reaches the server.
 *
 * Not localStorage, deliberately — storage restores the last screen you saw in
 * ANY tab, which is not what a reload or a shared link means. Two tabs on two
 * calls must stay on two calls.
 */
export type ScreenId =
  | 'overview'
  | 'convos'
  | 'convo'
  | 'ints'
  | 'int'
  | 'patterns'
  | 'scope';

export interface Route {
  screen: ScreenId;
  /** The open record on a detail screen. Null everywhere else. */
  id: string | null;
}

/** The URL segment for each screen. Detail screens append the record id. */
const SEGMENT: Record<ScreenId, string> = {
  overview: 'overview',
  convos: 'calls',
  convo: 'calls',
  ints: 'interventions',
  int: 'interventions',
  patterns: 'patterns',
  scope: 'scope',
};

/** Which screen a segment means, with and without a record id. */
const SCREEN_OF: Record<string, { list: ScreenId; detail: ScreenId }> = {
  overview: { list: 'overview', detail: 'overview' },
  calls: { list: 'convos', detail: 'convo' },
  interventions: { list: 'ints', detail: 'int' },
  patterns: { list: 'patterns', detail: 'patterns' },
  scope: { list: 'scope', detail: 'scope' },
};

export const DEFAULT_ROUTE: Route = { screen: 'overview', id: null };

/**
 * Read a route out of a hash. Anything unrecognised falls back to Overview
 * rather than rendering nothing — a typo in a pasted URL should land you
 * somewhere real.
 */
export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return DEFAULT_ROUTE;

  const entry = SCREEN_OF[parts[0]];
  if (!entry) return DEFAULT_ROUTE;

  // A detail segment with no id is the list — `#/calls/` is the call list, not
  // a broken detail screen with nothing to show.
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  return { screen: id ? entry.detail : entry.list, id };
}

export function formatHash(route: Route): string {
  const seg = SEGMENT[route.screen];
  const isDetail = route.screen === 'convo' || route.screen === 'int';
  return isDetail && route.id ? `#/${seg}/${encodeURIComponent(route.id)}` : `#/${seg}`;
}

/**
 * The current route, kept in step with the address bar.
 *
 * `hashchange` covers the browser's own back and forward buttons, so they work
 * without anything else being written for them.
 */
export function useHashRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);

    // Give a bare URL a real address, so the first thing you copy is a link
    // that comes back here. replaceState, not assignment: arriving at the app
    // should not leave a history entry you have to press back through twice.
    if (!window.location.hash) {
      window.history.replaceState(null, '', formatHash(DEFAULT_ROUTE));
    }
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = (next: Route) => {
    const hash = formatHash(next);
    if (hash === window.location.hash) return;
    // Assignment (not pushState) so the browser records the entry AND fires
    // hashchange — one code path keeps state and address bar in agreement.
    window.location.hash = hash;
  };

  return [route, navigate];
}
