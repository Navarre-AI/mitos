# Search test cases: what the sample data is built to prove

`eval/cases.json` is the machine form; `npm run eval` runs it against a
running server. Each case names the query, the kind the front door must
detect, the table and record that must appear, and (for typed queries) the
tables that must NOT appear. All of it is deterministic: a change in the
parser or the ranking shows up as a changed line.

## Words (people, organizations)
| You type | Should find | What it proves |
|---|---|---|
| `Murphy` | Siobhan Murphy | word start, title first |
| `matt nav` | Matt Navarre | every word must match; title wins |
| `Navarré` | Matt Navarre | accents are ignored |
| `"Cardiac Clinic"` | Phoenix Cardiac Clinic | a quoted phrase stays together |
| `Matt Navarre` | organization O0040 | joined employee names reach the employer |

## The name table (people)
| You type | Should find | What it proves |
|---|---|---|
| `Bob Whitfield` | Robert Whitfield | nickname to formal |
| `Peg Halloran` | Margaret Halloran | nickname to formal |
| `Shavon Murphy` | Siobhan Murphy | a phonetic spelling listed in the table |
| `Daren Umbridge` | Darren Umbridge | a common misspelling listed in the table |

## Numbers (products, `price`)
| You type | Should find | Must not search |
|---|---|---|
| `45`, `$65` | the product at that price | |
| `40...70` | Canvas Sneakers, Vans Old Skool | people, organizations |
| `>2000` | Pro Workstation, Creator Laptop | people, organizations |
| `<=45` | Canvas Sneakers | |

## Dates (people, `since`)
| You type | Should find | What it proves |
|---|---|---|
| `3/4/2019`, `2019-03-04` | Matt Navarre | one day, two spellings |
| `4.3.2019` | Astrid Navarre | both parts fit a month, so the configured order (mdy) decides |
| `19.3.2019` | Michael Smith | 19 cannot be a month, so the data decides |
| `3/2019` | Matt Navarre | a month |
| `3/1/2019...3/31/2019` | Matt Navarre | a range; products not searched |
| `>=2026-05-01` | Ματίας Ναβάρ | an open range |
| `2019` | Matt Navarre | a year reaches into date fields |

## Email and phone (people)
| You type | Should find | Must not search |
|---|---|---|
| `matt.navarre@` | Matt Navarre | products, organizations |
| `+11 629 773 9565` | Matt Navarre | products, organizations |
| `773-9565` | Matt Navarre | (the end of a number matches) |
| `6297739565` | Matt Navarre | read as a number, also tried as a phone |

## Out of scope for this version (by design)
- Misspellings not in the name table (`Umbrige`, `Shavon` without its entry).
- Synonyms (`heart clinic` for Cardiac Clinic). Semantic search is parked.
- Mixed inputs (`smith >5000`). One input, one kind.
