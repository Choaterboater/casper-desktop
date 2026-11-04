/**
 * Compatibility shim: Casper replaced the upstream fish mark with the ghost.
 * New code imports `GhostLogo` from `./GhostLogo.tsx`; these aliases keep older call sites working.
 */
export {
  GhostLogo as FishLogo,
  GHOST_LOGO_PATH as FISH_LOGO_PATH,
  GHOST_LOGO_VIEWBOX as FISH_LOGO_VIEWBOX,
} from './GhostLogo.tsx'
