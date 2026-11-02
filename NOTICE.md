# Licences and attribution

TABULA's own source code has no licence chosen yet. The data it is built on carries the conditions below.

| Source | Licence | Used for |
|---|---|---|
| [CShapes 2.0](https://icr.ethz.ch/data/cshapes/), Schvitz, Rüegger, Girardin, Cederman, Weidmann, Gleditsch (2022), *Journal of Conflict Resolution* 66(1) | CC BY-NC-SA 4.0 | Borders and capitals, 1886 to 2019 |
| [Historical Basemaps](https://github.com/aourednik/historical-basemaps), A. Ourednik and contributors | GPL-3.0 | Borders before 1886, optional after; places |
| Wikidata | CC0 | Identities, rulers, flags, languages, religions, events, cities |
| Wikipedia (English) | CC BY-SA 4.0 | Introductions, linked in each panel |
| Wikimedia Commons | Per file, shown with each image | Flags, emblems, portraits (linked, not copied) |
| NASA Blue Marble via GIBS | Public domain | Globe imagery |
| Spectral, Hanken Grotesk | SIL OFL | Type |

**Constraints that matter before any release:**

- **No commercial use without permission:** CShapes is non-commercial, so a paid or ad-funded TABULA needs permission from its authors.
- **Share-alike:** derived data from CShapes must stay under CC BY-NC-SA, and derived data from Historical Basemaps under GPL-3.0. These two terms do not combine into one licence. TABULA keeps the two datasets in separate tile sets and never merges their geometry, but the one database file holds both, so it should not be redistributed as a single dataset without legal advice. The published site does distribute the exported files in `packages/web/public/data`, where they stay separate: `cs` files (tile archive, labels, `cs:` entities) derive from CShapes, `hb_` files and `hb:` entities from Historical Basemaps. This note is not legal advice.
