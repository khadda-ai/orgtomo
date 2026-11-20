---
name: orgtomo-flow-edit
description: "How to change an existing Flow safely by editing its metadata XML with a minimal diff. Use for any modification of a Flow that already exists."
user-invocable: false
---
# Editing an existing Flow

The Salesforce Flow generator creates new flows. It does not edit existing ones. Existing flows are changed in their `.flow-meta.xml` file.

## Before editing

1. Backup: `orgtomo org backup <KEY> "Flow:<ApiName>"`.
2. Retrieve the current version into source if the file may be behind the org.
3. Read the whole file once. Note the `start` element (object, trigger type, entry conditions), every element name, and how elements are connected (`connector` / `targetReference`).

## Rules

- Keep every existing element name and `locationX` / `locationY`. Renaming breaks references; moving creates noise.
- Add new elements with names that follow the org's flow element rules (skill `org-naming`), each with a `label`.
- Wire a new element by changing exactly the connectors that must point to it, and give it its own connector onward. Check that no path is left without an end.
- Keep elements of the same kind grouped together the way the file already has them; Metadata API expects elements of one type to be contiguous.
- Do not change `apiVersion`, `status` or `processMetadataValues` unless the plan says so.
- Update the flow `description`: what the flow does, plus one line naming the ticket and the change.
- A decision outcome needs conditions, a label and a connector. A record update needs filters or an input reference. Fill every required child the same way neighbouring elements of that type do.

## After editing

- `orgtomo org deploy <KEY> <flow path> --check`. Flow errors are precise; read them.
- Deploy. A deployed flow keeps its activation status from the file's `status`.
- The Tester proves behaviour; you prove it deploys.
