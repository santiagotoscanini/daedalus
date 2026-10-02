-- The off-box project list is discovered from GitHub Pages and Vercel since
-- this release (app/src/core/offbox/); the hand-typed rows it replaces have
-- no reader left.
DELETE FROM "settings" WHERE "key" = 'apps.external';
