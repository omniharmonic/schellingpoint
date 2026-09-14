# Gathering space — UX polish direction

The app helps people turn shared curiosity into a gathering. Its personality comes from connections between people, rather than terminal metaphors.

Palette: mineral #F7F9F8, paper #FFFFFF, ink #202D2A, spruce #246653, pale mint #E8F1EB, lilac #DCD5ED. Color communicates participation, track identity, and actionable status. Preserve event branding overrides.

Typography: locally hosted BDO Grotesk for both reading and display, generous heading sizes, sentence case for navigation and metadata. Reserve tabular numerals for counts. No network font dependency.

Layout: left-aligned public headline beside a geometric, interactive gathering diagram. Spacious event directory below. Persistent sidebar and contextual top bar for event tools. Admin groups program, community, and event operations; proposal review leads with the next useful action.

    Public:  [clear invitation      ][connected gathering diagram]
             [propose / vote / gather explanation                ]
             [event discovery                                   ]
    Tools:   [event + nav] [context / event preview               ]
             [          ] [page heading + primary action        ]
             [          ] [attention / workflow                 ]
             [account   ] [filters and content                  ]

Brief review: a dark phosphor dashboard and tiny monospace protocol labels would repeat the existing problem. Use daylight, readable text, and a single network illustration instead. Avoid treating participants as “nodes.” Keep the mathematical structure in voting and scheduling; make the language human.

Quality checks: desktop and phone layouts, keyboard focus, reduced motion, meaningful empty/error states, auth return paths, tenant-safe vote display, type check, production build, browser smoke tests. No live email, payment, or production data mutations during visual verification.

## Bolder second pass — scroll as explanation

Use a large, open typographic invitation followed by a sticky working illustration. The three scroll chapters follow the actual sequence: propose → vote → gather. Each chapter explains a real participant action, and the illustration lets the reader try it. Example data is clearly identified; no fake activity or simulated real votes. Normal page scrolling and direct chapter links both work.

Palette extends the existing paper #F7F9F8, ink #202D2A, spruce #246653 and lilac #DCD5ED with citron #E8EF86 and mint #BBDAC5. BDO Grotesk remains the sole family; larger display type carries the boldness. Event cards become distinct posters with big calendar dates and event identity. Dashboards use a strong contextual header; calendars use clear day tabs, venue headings, and solid session boundaries.

Layout: [oversized invitation | explorable idea field], then [sticky demonstration | three sequential scroll chapters], then [event posters]. Mobile keeps chapters adjacent to their corresponding demonstration instead of trapping the page in a large sticky region. No scroll hijacking, no automatic carousel, no repetitive reveal effects. Motion responds to scrolling or interaction and respects reduced motion.

Brief critique: simply enlarging all rounded cards would preserve the original neutrality. Spend the visual emphasis on the changing idea field and event posters; keep controls and dense schedule data functional.
