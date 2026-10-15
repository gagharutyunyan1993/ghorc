'use strict';

// Turns a title into a URL slug: lowercase, words joined by single hyphens.
function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
