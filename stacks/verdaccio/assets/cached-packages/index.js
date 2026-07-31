'use strict';

// verdaccio-cached-packages — make the web UI show packages CACHED from an
// uplink, not only the ones published to this registry.
//
// Why this exists
// ---------------
// Verdaccio's front page (`/-/verdaccio/data/packages`) and its search box
// (`/-/verdaccio/data/search/:q`) both read `storage.getLocalDatabase()`,
// whose own doc comment says "Retrieve only private local packages": it
// returns the `list` array of `.verdaccio-db.json`, which is appended to on
// publish and never on cache. So a pure proxy registry shows an empty UI
// while holding hundreds of packages on disk. Upstream declined to change
// this (verdaccio discussion #706) on the grounds that scanning the whole
// FS-backed storage per page view is expensive — hence the TTL cache below.
//
// Packages holding more than one version are sorted to the top of the
// listing and labelled, since on a proxy registry those are where the disk
// is going and where a dependency tree has drifted apart.
//
// It also serves GET /-/cached-packages/stats for the homepage tile,
// which otherwise has no way to tell published from cached or to count
// past 250. See the handler for what each count does and does not mean.
//
// How it hooks in
// ---------------
// `defineAPI` registers plugin middlewares BEFORE the built-in web router:
//
//     plugins.forEach((p) => p.register_middlewares(app, auth, storage));
//     app.use(endpointApi(...));   // <- built-in, first-match-wins loses
//
// so claiming the two routes here shadows the built-ins. Anything this
// plugin cannot answer falls through via `next()` to the original handler,
// which still returns the private-package list.
//
// Constraints this file works under
// ---------------------------------
//   - NO `require('@verdaccio/*')`. The plugin is loaded by absolute path
//     from /verdaccio/plugins, so its module resolution walks
//     /verdaccio/plugins/**/node_modules and never reaches verdaccio's own
//     deps under /usr/local/lib. Node builtins plus the injected
//     `storage`/`auth` handles only; helpers verdaccio would have imported
//     (formatAuthor, tarball URL rewriting) are reimplemented below.
//   - Package detail pages already work for cached packages — `getPackage`
//     was never restricted to the private list — so only the two index
//     routes need shadowing.
//   - The built-in web router also applies `setSecurityWebHeaders`; these
//     routes bypass it. Both responses are XHR JSON, and traefik's
//     `sec-headers` middleware already sets the transport-level headers.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROUTE_PACKAGES = '/-/verdaccio/data/packages';
const ROUTE_SEARCH = '/-/verdaccio/data/search/:anything';
// Own namespace, not `/-/verdaccio/*`: this one is additive rather than a
// shadow of an upstream route, so it must not collide with a future one.
const ROUTE_STATS = '/-/cached-packages/stats';

const DEFAULT_TTL_SECONDS = 60;
// Manifests are small JSON reads; this only bounds the open-file burst.
const READ_CONCURRENCY = 12;
const DEFAULT_USER = 'Anonymous';

// Mirrors @verdaccio/utils formatAuthor. The UI card destructures
// `author.name`, so author must always be an object.
function formatAuthor(author) {
  const base = { name: DEFAULT_USER, email: '', url: '' };
  if (author === null || author === undefined) return base;
  if (typeof author === 'string') return { ...base, name: author };
  if (typeof author === 'object') return { ...base, ...author };
  return base;
}

function gravatarUrl(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return undefined;
  const hash = crypto.createHash('md5').update(normalized).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}`;
}

// Mirrors @verdaccio/tarball getLocalRegistryTarballUri: point the download
// button at this registry so the fetch is proxied and cached, instead of
// sending the browser straight to the uplink.
function localTarballUri(uri, packageName, req) {
  if (typeof uri !== 'string' || !uri) return uri;
  const tarballName = uri.replace(/\?.*$/, '').split('/').pop();
  if (!tarballName) return uri;
  const publicUrl =
    process.env.VERDACCIO_PUBLIC_URL ||
    `${req.protocol}://${req.headers.host}`;
  return `${publicUrl.replace(/\/+$/, '')}/${packageName}/-/${tarballName}`;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

module.exports = function cachedPackagesPlugin(config, options) {
  const logger = options.logger;

  // The middleware loader runs with legacyMergeConfigs, so `config` is the
  // whole verdaccio config with this plugin's own section merged on top.
  const ttlMs =
    (Number(config.ttl) > 0 ? Number(config.ttl) : DEFAULT_TTL_SECONDS) * 1000;
  const useGravatar = Boolean(config.web && config.web.gravatar);
  const descending = Boolean(config.web && config.web.sort_packages === 'desc');
  // Per-package `storage:` overrides are not followed; this reads the one
  // global storage root, which is what a proxy registry writes its cache to.
  const storageDir = path.resolve(
    path.dirname(config.configPath || config.self_path || ''),
    config.storage || 'storage'
  );

  let cache = null;
  let inFlight = null;

  async function scanNames() {
    const entries = await fsp.readdir(storageDir, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!entry.name.startsWith('@')) {
        names.push(entry.name);
        continue;
      }
      const scoped = await fsp.readdir(path.join(storageDir, entry.name), {
        withFileTypes: true,
      });
      for (const child of scoped) {
        if (child.isDirectory() && !child.name.startsWith('.')) {
          names.push(`${entry.name}/${child.name}`);
        }
      }
    }
    return names;
  }

  function readManifest(storage, name, req) {
    return new Promise((resolve) => {
      storage.getPackage({
        name,
        req,
        // Local read only: never let a UI page view fan out to the uplink.
        uplinksLook: false,
        callback: (err, manifest) => resolve(err ? null : manifest),
      });
    });
  }

  // How many versions are actually HELD, which is not the same as the
  // number of versions the manifest knows about: a cached manifest carries
  // the uplink's entire version history (chalk: 44) while only the fetched
  // tarballs are on disk (chalk: 3). Verdaccio's own `_attachments` agrees
  // with the disk for every package here, but `getPackage` blanks that
  // field, so count the tarballs instead of paying for a second parse.
  async function countHeldVersions(name) {
    try {
      const entries = await fsp.readdir(path.join(storageDir, name));
      return entries.filter((entry) => entry.endsWith('.tgz')).length;
    } catch {
      return 0;
    }
  }

  // The UI card reads the LATEST version manifest, not the package document.
  function toCard(manifest, heldVersions) {
    if (!manifest || !manifest.versions) return null;
    const latest = manifest['dist-tags'] && manifest['dist-tags'].latest;
    if (!latest || !manifest.versions[latest]) return null;

    const card = { ...manifest.versions[latest] };
    card.time = manifest.time ? manifest.time[latest] : undefined;
    card.users = manifest.users;
    card.author = formatAuthor(card.author);
    if (useGravatar) card.author.avatar = gravatarUrl(card.author.email);
    card.heldVersions = heldVersions;
    return card;
  }

  // The publish list verdaccio would have shown on its own. Packages
  // published here also live in the storage dir, so this is what separates
  // "ours" from "cached from an uplink" in a storage scan.
  function readPrivateNames(storage) {
    return new Promise((resolve) => {
      try {
        storage.getLocalDatabase((err, packages) =>
          resolve(
            err || !Array.isArray(packages)
              ? new Set()
              : new Set(packages.map((pkg) => pkg.name))
          )
        );
      } catch {
        resolve(new Set());
      }
    });
  }

  async function rebuild(storage, req) {
    const [names, privateNames] = await Promise.all([
      scanNames(),
      readPrivateNames(storage),
    ]);
    const cards = (await mapPool(names, READ_CONCURRENCY, async (name) => {
      const [manifest, heldVersions] = await Promise.all([
        readManifest(storage, name, req),
        countHeldVersions(name),
      ]);
      return toCard(manifest, heldVersions);
    })).filter(Boolean);

    // Packages holding more than one version float to the top, most
    // versions first — they are the ones worth looking at on a proxy
    // registry, since they are where disk is going and where a dependency
    // tree has drifted apart. Everything else keeps the configured
    // alphabetical order. The UI renders this array as-is; it does no
    // client-side sorting of its own.
    const byName = (a, b) =>
      descending ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
    cards.sort((a, b) => {
      const aMulti = a.heldVersions > 1;
      const bMulti = b.heldVersions > 1;
      if (aMulti !== bMulti) return aMulti ? -1 : 1;
      if (aMulti && a.heldVersions !== b.heldVersions) {
        return b.heldVersions - a.heldVersions;
      }
      return byName(a, b);
    });
    cache = { at: Date.now(), cards, privateNames };
    logger.debug(
      { total: cards.length, published: privateNames.size },
      'cached-packages indexed @{total} packages (@{published} published here)'
    );
    return cache;
  }

  async function collect(storage, req) {
    if (cache && Date.now() - cache.at < ttlMs) return cache;
    // The front page, the search box and the stats tile can all miss on the
    // same tick; share one scan between them instead of walking storage
    // once per caller.
    if (!inFlight) {
      inFlight = rebuild(storage, req).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function allowed(auth, name, remoteUser) {
    return new Promise((resolve) => {
      try {
        auth.allow_access({ packageName: name }, remoteUser, (err, ok) =>
          resolve(!err && Boolean(ok))
        );
      } catch {
        resolve(false);
      }
    });
  }

  async function filterAllowed(auth, cards, req) {
    const verdicts = await mapPool(cards, READ_CONCURRENCY, (card) =>
      allowed(auth, card.name, req.remote_user)
    );
    return cards.filter((_, index) => verdicts[index]);
  }

  function matches(card, term) {
    const needle = term.toLowerCase();
    const keywords = Array.isArray(card.keywords)
      ? card.keywords.join(' ')
      : card.keywords || '';
    return [card.name, card.description || '', keywords].some((field) =>
      String(field).toLowerCase().includes(needle)
    );
  }

  // Applied on the way out, not baked into the cached card, so that the
  // search box still matches against the real description.
  function forResponse(card, req) {
    const out = { ...card };
    if (card.dist && card.dist.tarball) {
      out.dist = {
        ...card.dist,
        tarball: localTarballUri(card.dist.tarball, card.name, req),
      };
    }
    // The card component renders a fixed set of fields, and `description`
    // is the only free-text one — so the version count rides there. A
    // keyword chip was the alternative, but those are package metadata and
    // the UI alphabetises them, so the count would move around.
    if (card.heldVersions > 1) {
      const label = `${card.heldVersions} versions cached`;
      out.description = card.description
        ? `${label} · ${card.description}`
        : label;
    }
    return out;
  }

  function respond(handler) {
    return async (req, res, next) => {
      try {
        const cards = await handler(req);
        res.json(cards.map((card) => forResponse(card, req)));
      } catch (err) {
        // Hand the route back to verdaccio's own handler rather than 500 —
        // a degraded UI showing only published packages beats a broken one.
        logger.error(
          { err: err.message },
          'cached-packages failed, falling back to the built-in handler: @{err}'
        );
        next();
      }
    };
  }

  return {
    register_middlewares(app, auth, storage) {
      if (config.enabled === false) {
        logger.info('cached-packages is disabled, leaving the web UI as-is');
        return;
      }

      // Same token middleware the built-in web router uses; it no-ops when
      // apiJWTmiddleware (registered earlier) already resolved the user, and
      // decodes the web UI's bearer token otherwise.
      const webToken = auth.webUIJWTmiddleware();

      app.get(
        ROUTE_PACKAGES,
        webToken,
        respond(async (req) => {
          const { cards } = await collect(storage, req);
          return filterAllowed(auth, cards, req);
        })
      );

      app.get(
        ROUTE_SEARCH,
        webToken,
        respond(async (req) => {
          const term = String(req.params.anything || '');
          const { cards } = await collect(storage, req);
          return filterAllowed(
            auth,
            cards.filter((card) => matches(card, term)),
            req
          );
        })
      );

      // Counts for the homepage tile. Verdaccio's own /-/v1/search reports
      // the returned page length, so it saturates at that endpoint's 250
      // cap and cannot separate published from cached.
      app.get(ROUTE_STATS, webToken, async (req, res, next) => {
        try {
          const { cards, privateNames } = await collect(storage, req);
          const visible = await filterAllowed(auth, cards, req);
          const cached = visible.filter((card) => !privateNames.has(card.name));
          res.json({
            published: visible.length - cached.length,
            // Unique package names, which is what the UI lists. NOT the
            // same as the number of versions held, and not even the same
            // as the number of packages holding anything: resolving a
            // dependency tree caches a manifest whether or not a tarball
            // is ever pulled, so `cached` counts some packages that are
            // metadata only. `cachedWithTarball` is the stricter reading.
            cached: cached.length,
            cachedVersions: cached.reduce(
              (sum, card) => sum + (card.heldVersions || 0),
              0
            ),
            cachedWithTarball: cached.filter((card) => card.heldVersions > 0)
              .length,
            multiVersion: cached.filter((card) => card.heldVersions > 1).length,
            total: visible.length,
          });
        } catch (err) {
          logger.error(
            { err: err.message },
            'cached-packages stats failed: @{err}'
          );
          next(err);
        }
      });

      logger.info(
        { storageDir },
        'cached-packages is serving the web UI index from @{storageDir}'
      );
    },
  };
};
