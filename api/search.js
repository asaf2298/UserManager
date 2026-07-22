// Thin re-export so api/subtitles.js and other api/* modules share one meta helper.
export {
  getCleanMovieName,
  getContentMeta,
  buildSearchTitles,
  isDubbedQuery
} from '../lib/search.js';
