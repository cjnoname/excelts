/**
 * Every diagram type, to every backend.
 *
 * Run with `npx tsx src/modules/mermaid/examples/gallery.ts`; output lands in `tmp/mermaid`.
 *
 * The point of the example is the middle of it: each diagram is converted to a display
 * list *once*, and the SVG, the PNG and the PDF are three readings of that one list. A
 * producer written against the drawing engine does not implement a backend, and this is
 * what that buys.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { encodePng } from "@archive/png";
import { rasterizeToRgba, renderDrawList } from "@draw/index";
import { toSvg } from "@draw/svg";
import { mermaidToDrawList } from "@mermaid/index";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import { createPdfDrawSurface } from "@pdf/render/draw-surface";

const OUT = path.join(process.cwd(), "tmp", "mermaid");

const DIAGRAMS: Array<[string, string]> = [
  [
    "flowchart",
    `flowchart TD
      A[Christmas] -->|Get money| B(Go shopping)
      B --> C{Let me think}
      C -->|One| D[Laptop]
      C -->|Two| E[iPhone]
      C -->|Three| F[Car]`
  ],
  [
    "shapes",
    `flowchart TD
      a[rect] --> b(round) --> c([stadium]) --> d[[subroutine]]
      d --> e[(database)] --> f((circle)) --> g{rhombus}
      g --> h{{hexagon}} --> i[/parallelogram/] --> j[/trapezoid\\] --> k>asymmetric]`
  ],
  [
    "links",
    `flowchart LR
      A --> B
      A --- C
      A -.-> D
      A ==> E
      A --o F
      A --x G`
  ],
  [
    "subgraphs",
    `flowchart TB
      subgraph ingest [Ingest]
        A[Read] --> B[Validate]
      end
      subgraph store [Store]
        C[(Database)]
      end
      B --> C
      C --> D[Report]`
  ],
  [
    "cycle",
    `flowchart TD
      A[Draft] --> B[Review]
      B --> C{Approved?}
      C -->|no| A
      C -->|yes| D[Publish]`
  ],
  [
    "classes",
    `flowchart LR
      A[Normal] --> B[Hot]:::hot --> C[Cool]:::cool
      classDef hot fill:#ffd9d9,stroke:#c0392b,stroke-width:2px
      classDef cool fill:#d9ecff,stroke:#2874a6,stroke-width:2px`
  ],
  [
    "pie",
    `pie showData title Where the time goes
      "Parsing" : 35
      "Layout" : 25
      "Rendering" : 30
      "Everything else" : 10`
  ],
  [
    "sequence",
    `sequenceDiagram
      autonumber
      participant U as User
      participant A as API
      participant D as Database
      U->>A: POST /orders
      Note right of U: idempotency key
      alt payment accepted
        A->>D: INSERT order
        D-->>A: ok
        A-->>U: 201 Created
      else declined
        A-->>U: 402 Payment Required
      end
      loop every 30s
        A->>D: heartbeat
      end
      Note over A,D: same VPC`
  ],
  [
    "state",
    `stateDiagram-v2
      [*] --> Idle
      Idle --> Running : start
      Running --> Paused : pause
      Paused --> Running : resume
      Running --> Done : finish
      Done --> [*]
      state "Waiting for input" as Idle`
  ],
  [
    "class",
    `classDiagram
      class Animal {
        +String name
        -int age
        +move(distance) bool
        +speak()
      }
      class Duck {
        +String beakColour
        +swim()
      }
      class Flyer {
        <<interface>>
        +fly()
      }
      Animal <|-- Duck
      Duck ..|> Flyer
      Animal "1" *-- "0..*" Leg
      Duck --> Pond : lives in`
  ],
  [
    "er",
    `erDiagram
      CUSTOMER ||--o{ ORDER : places
      ORDER ||--|{ LINE_ITEM : contains
      CUSTOMER }|..|{ DELIVERY_ADDRESS : uses
      CUSTOMER {
        string name PK
        string email UK
        int loyaltyPoints
      }
      ORDER {
        int id PK
        string customerId FK
        date placedAt
      }`
  ],
  [
    "gantt",
    `gantt
      title Release plan
      dateFormat YYYY-MM-DD
      section Design
        Research        :done, r1, 2024-01-01, 12d
        Wireframes      :done, w1, after r1, 8d
      section Build
        Core engine     :active, c1, after w1, 25d
        Integrations    :i1, after c1, 14d
        Feature freeze  :milestone, m1, after i1, 0d
      section Ship
        Beta            :crit, b1, after m1, 10d
        Launch          :after b1, 5d`
  ],
  [
    "timeline",
    `timeline
      title History of social media
      section Early
        2002 : LinkedIn
        2004 : Facebook : Google
      section Growth
        2005 : YouTube
        2006 : Twitter`
  ],
  [
    "journey",
    `journey
      title My working day
      section Go to work
        Make tea: 5: Me
        Go upstairs: 3: Me
        Do work: 1: Me, Cat
      section Go home
        Go downstairs: 5: Me
        Sit down: 5: Me`
  ],
  [
    "mindmap",
    `mindmap
  root((documonster))
    Excel
      Workbook
      Formula
    Word
      DocxDocument
    PDF
      Builder
      Reader
    Draw
      DrawList
      Backends`
  ],
  [
    "gitgraph",
    `gitGraph
      commit id: "init"
      commit
      branch develop
      commit
      commit tag: "v0.1"
      checkout main
      merge develop
      branch hotfix
      commit type: HIGHLIGHT
      checkout main
      merge hotfix tag: "v1.0"`
  ],
  [
    "quadrant",
    `quadrantChart
      title Reach and engagement
      x-axis Low Reach --> High Reach
      y-axis Low Engagement --> High Engagement
      quadrant-1 We should expand
      quadrant-2 Need promotion
      quadrant-3 Re-evaluate
      quadrant-4 May be improved
      Campaign A: [0.34, 0.78]
      Campaign B: [0.62, 0.40]
      Campaign C: [0.78, 0.72]
      Campaign D: [0.25, 0.22]`
  ],
  [
    "xychart",
    `xychart-beta
      title "Monthly revenue"
      x-axis [jan, feb, mar, apr, may, jun]
      y-axis "Revenue (k)" 0 --> 110
      bar [42, 58, 31, 67, 88, 74]
      line [30, 45, 40, 60, 80, 70]`
  ],
  [
    "sankey",
    `sankey-beta
      Agricultural waste,Bio-conversion,124
      Bio-conversion,Liquid,0.6
      Bio-conversion,Losses,26
      Bio-conversion,Solid,280
      Bio-conversion,Gas,81
      Solid,District heating,46
      Gas,Losses,12`
  ],
  [
    "requirement",
    `requirementDiagram
      requirement test_req {
        id: 1
        text: the test text
        risk: high
        verifymethod: test
      }
      functionalRequirement sub_req {
        id: 1.1
        text: the sub text
        risk: low
      }
      element test_entity {
        type: simulation
      }
      test_entity - satisfies -> test_req
      test_req - contains -> sub_req`
  ],
  [
    "c4",
    `C4Context
      title System context for the internet banking system
      Person(customer, "Banking customer", "A customer of the bank")
      System(banking, "Internet banking", "Lets customers view accounts")
      System_Ext(mail, "E-mail system", "The internal Microsoft Exchange")
      Rel(customer, banking, "Uses", "HTTPS")
      Rel(banking, mail, "Sends e-mail", "SMTP")`
  ],
  [
    "block",
    `block-beta
      columns 3
      a["Ingest"] b["Transform"] c["Load"]
      d["Queue"]:2 e(("Store"))
      a --> b
      b --> c`
  ],
  [
    "packet",
    `packet-beta
      title TCP header
      0-15: "Source Port"
      16-31: "Destination Port"
      32-63: "Sequence Number"
      64-95: "Acknowledgment Number"
      96-99: "Data Offset"
      100-105: "Reserved"
      106: "URG"
      107: "ACK"
      108: "PSH"
      109: "RST"
      110: "SYN"
      111: "FIN"
      112-127: "Window"`
  ],
  [
    "kanban",
    `kanban
      title Sprint 14
      todo[To do]
        t1[Design the schema]@{ assigned: "Ada", priority: "High" }
        t2[Write the parser]@{ assigned: "Grace" }
      doing[In progress]
        t3[Port the renderer]@{ assigned: "Alan", priority: "Very High" }
      done[Done]
        t4[Set up CI]@{ ticket: "OPS-12" }`
  ],
  [
    "radar",
    `radar-beta
      title Skill coverage
      axis Parsing, Layout, Rendering, Testing, Docs
      curve current["Current"]{4, 3, 5, 4, 2}
      curve target["Target"]{5, 5, 5, 5, 4}
      max 5`
  ],
  [
    "architecture",
    `architecture-beta
      group api(cloud)[API]
      service db(database)[Database] in api
      service server(server)[Server] in api
      service disk(disk)[Storage] in api
      db --> server
      server --> disk`
  ]
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  for (const [name, source] of DIAGRAMS) {
    // Once. Everything below reads this.
    const list = mermaidToDrawList(source, { background: "#ffffff" });

    writeFileSync(path.join(OUT, `${name}.svg`), toSvg(list));

    const image = rasterizeToRgba(list, { scale: 2 });
    writeFileSync(path.join(OUT, `${name}.png`), encodePng(image.data, image.width, image.height));

    const builder = new PdfDocumentBuilder();
    const page = builder.addPage({ width: list.width + 40, height: list.height + 40 });
    renderDrawList(
      list,
      createPdfDrawSurface(page, { x: 20, y: 20, width: list.width, height: list.height })
    );
    writeFileSync(path.join(OUT, `${name}.pdf`), await builder.build());
  }

  console.log(`Wrote ${DIAGRAMS.length} diagrams (svg + png + pdf) to ${OUT}`);
}

void main();
