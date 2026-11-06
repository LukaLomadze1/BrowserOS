/**
 * @file Curated cities for the world clock search. Times are always
 * computed by Intl.DateTimeFormat with the IANA zone, so daylight
 * saving is applied by the browser's own time-zone database. Search
 * also falls back to every zone reported by Intl.supportedValuesOf, so
 * any time zone can be added, not just the cities listed here.
 */

/** @type {ReadonlyArray<{city: string, country: string, timeZone: string}>} */
export const CITIES = Object.freeze(
  [
    ["Abu Dhabi", "United Arab Emirates", "Asia/Dubai"],
    ["Amsterdam", "Netherlands", "Europe/Amsterdam"],
    ["Anchorage", "United States", "America/Anchorage"],
    ["Athens", "Greece", "Europe/Athens"],
    ["Auckland", "New Zealand", "Pacific/Auckland"],
    ["Bangkok", "Thailand", "Asia/Bangkok"],
    ["Barcelona", "Spain", "Europe/Madrid"],
    ["Beijing", "China", "Asia/Shanghai"],
    ["Berlin", "Germany", "Europe/Berlin"],
    ["Bogot\u00e1", "Colombia", "America/Bogota"],
    ["Brussels", "Belgium", "Europe/Brussels"],
    ["Buenos Aires", "Argentina", "America/Argentina/Buenos_Aires"],
    ["Cairo", "Egypt", "Africa/Cairo"],
    ["Cape Town", "South Africa", "Africa/Johannesburg"],
    ["Chicago", "United States", "America/Chicago"],
    ["Copenhagen", "Denmark", "Europe/Copenhagen"],
    ["Delhi", "India", "Asia/Kolkata"],
    ["Denver", "United States", "America/Denver"],
    ["Dubai", "United Arab Emirates", "Asia/Dubai"],
    ["Dublin", "Ireland", "Europe/Dublin"],
    ["Helsinki", "Finland", "Europe/Helsinki"],
    ["Hong Kong", "China", "Asia/Hong_Kong"],
    ["Honolulu", "United States", "Pacific/Honolulu"],
    ["Istanbul", "Turkey", "Europe/Istanbul"],
    ["Jakarta", "Indonesia", "Asia/Jakarta"],
    ["Jerusalem", "Israel", "Asia/Jerusalem"],
    ["Johannesburg", "South Africa", "Africa/Johannesburg"],
    ["Karachi", "Pakistan", "Asia/Karachi"],
    ["Kathmandu", "Nepal", "Asia/Kathmandu"],
    ["Kyiv", "Ukraine", "Europe/Kyiv"],
    ["Lagos", "Nigeria", "Africa/Lagos"],
    ["Lima", "Peru", "America/Lima"],
    ["Lisbon", "Portugal", "Europe/Lisbon"],
    ["London", "United Kingdom", "Europe/London"],
    ["Los Angeles", "United States", "America/Los_Angeles"],
    ["Madrid", "Spain", "Europe/Madrid"],
    ["Manila", "Philippines", "Asia/Manila"],
    ["Melbourne", "Australia", "Australia/Melbourne"],
    ["Mexico City", "Mexico", "America/Mexico_City"],
    ["Miami", "United States", "America/New_York"],
    ["Moscow", "Russia", "Europe/Moscow"],
    ["Mumbai", "India", "Asia/Kolkata"],
    ["Nairobi", "Kenya", "Africa/Nairobi"],
    ["New York", "United States", "America/New_York"],
    ["Oslo", "Norway", "Europe/Oslo"],
    ["Paris", "France", "Europe/Paris"],
    ["Prague", "Czechia", "Europe/Prague"],
    ["Reykjav\u00edk", "Iceland", "Atlantic/Reykjavik"],
    ["Riyadh", "Saudi Arabia", "Asia/Riyadh"],
    ["Rome", "Italy", "Europe/Rome"],
    ["San Francisco", "United States", "America/Los_Angeles"],
    ["Santiago", "Chile", "America/Santiago"],
    ["S\u00e3o Paulo", "Brazil", "America/Sao_Paulo"],
    ["Seattle", "United States", "America/Los_Angeles"],
    ["Seoul", "South Korea", "Asia/Seoul"],
    ["Shanghai", "China", "Asia/Shanghai"],
    ["Singapore", "Singapore", "Asia/Singapore"],
    ["Stockholm", "Sweden", "Europe/Stockholm"],
    ["Sydney", "Australia", "Australia/Sydney"],
    ["Taipei", "Taiwan", "Asia/Taipei"],
    ["Tbilisi", "Georgia", "Asia/Tbilisi"],
    ["Tehran", "Iran", "Asia/Tehran"],
    ["Tokyo", "Japan", "Asia/Tokyo"],
    ["Toronto", "Canada", "America/Toronto"],
    ["Vancouver", "Canada", "America/Vancouver"],
    ["Vienna", "Austria", "Europe/Vienna"],
    ["Warsaw", "Poland", "Europe/Warsaw"],
    ["Zurich", "Switzerland", "Europe/Zurich"],
  ].map(([city, country, timeZone]) => Object.freeze({ city, country, timeZone }))
);

/**
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<{city: string, country: string, timeZone: string}>} Matching cities first, then matching IANA zones.
 */
export function searchCities(query, limit = 12) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results = CITIES.filter(
    (entry) => entry.city.toLowerCase().includes(needle) || entry.country.toLowerCase().includes(needle) || entry.timeZone.toLowerCase().includes(needle)
  ).sort((a, b) => Number(!a.city.toLowerCase().startsWith(needle)) - Number(!b.city.toLowerCase().startsWith(needle)) || a.city.localeCompare(b.city));

  if (results.length < limit && typeof Intl.supportedValuesOf === "function") {
    const known = new Set(results.map((entry) => entry.timeZone));
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      if (results.length >= limit) break;
      if (known.has(zone) || !zone.toLowerCase().replace(/_/g, " ").includes(needle)) continue;
      const parts = zone.split("/");
      results.push({ city: parts.at(-1).replace(/_/g, " "), country: parts[0], timeZone: zone });
      known.add(zone);
    }
  }
  return results.slice(0, limit);
}
