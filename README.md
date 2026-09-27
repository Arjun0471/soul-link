# Soul Link Tracker

A shared tracker for Pokémon **Soul Link** Nuzlocke runs. Each encounter is linked to your partner's encounter on the same route: if one faints, both are dead. Both players open the same link, and every change shows up live on the other person's screen.

- Each player has their own team panel: a 6-slot party with their box underneath. Linked partners don't both have to be in the party.
  - **↑ Party** / **↓ Box** on any Pokémon, or drag between party and box on desktop (drop onto a party member to swap them)
  - Sending a Pokémon to a full party asks who to swap out
  - **Fainted** right from the party marks the linked pair dead (the Pokémon's owner is preselected as the one who fell)
  - A party can never hold more than 6. If you both add a 7th at the same moment on different machines, the newest arrival is boxed automatically.
- **Evolve** appears on a Pokémon (in the party and on its encounter card) only when it has an evolution. A single evolution is preselected with a before/after preview; branching ones like Eevee get a dropdown. The nickname is kept along with a "caught as" note.
- Alive, graveyard and failed-encounter lists; a death takes the whole linked pair
- Half-caught pairs are easy to finish: **Add Sam's catch** on the encounter card or party slot, or pick it from the *Waiting on a partner's catch* list when adding an encounter. Only that player's half is written, so it never overwrites the partner's edits.
- Sprites and types looked up automatically from [PokéAPI](https://pokeapi.co). Species autocomplete includes regional forms.
- Warns when a player's party has two Pokémon with the same primary type (a common Soul Link rule; you can turn this off in Settings)
- Records who fainted and the cause of death, plus notes on each encounter
- Supports 2 to 4 players
- JSON export and import for backups
- Live sync through Firebase Realtime Database. Edits made while offline are queued and synced when the connection comes back.

It's a static site (plain HTML, CSS and JS, no build step) hosted on GitHub Pages, with Firebase as the shared database.

## Setup (one time, about 10 minutes)

### 1. Create the Firebase database

1. Go to <https://console.firebase.google.com> and **Create a project** (the free Spark plan is plenty). You can turn Google Analytics off.
2. In the left menu, open **Build → Realtime Database → Create Database**. Pick a location and start in **locked mode**.
3. Open the **Rules** tab, replace the contents with what's in [`database.rules.json`](database.rules.json), and click **Publish**.
4. Go to **Project settings** (the gear icon) **→ Your apps → Web (`</>`)**, register an app with any nickname (skip Firebase Hosting), and copy the `firebaseConfig` object it shows you.
5. Paste those values into [`firebase-config.js`](firebase-config.js). The important one is `databaseURL`. If it's missing from the snippet, copy the URL shown at the top of the Realtime Database page.

Firebase web config values are **not secrets**; they only identify the project. Access is controlled by the database rules.

### 2. Publish on GitHub Pages

1. Commit and push `firebase-config.js` to the `main` branch.
2. On GitHub, open **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then `main` / `(root)`, and save.
3. After a minute the site is live at `https://<your-username>.github.io/soul-link/`.

### 3. Play

1. One of you opens the site and clicks **Create run**.
2. Click **Copy share link** and send it to your partner.
3. You both use that link. It includes the run code (`#run=…`), and recent runs are also listed on the home page.

The status pill in the top bar shows **● Live** when you're connected. If it shows **Local only**, Firebase isn't configured and the run is saved only in that browser.

## How the data is stored

Every run lives at `runs/<runId>` in the database:

```
runs/<runId>/meta        run name, game, rule toggles
runs/<runId>/players/<playerId>   { name, order }
runs/<runId>/links/<linkId>       { location, status: alive|dead|missed, encounters: { <playerId>: { species, nickname, inParty, caughtAs, dexId, types } }, fainted, cause, notes }
```

Each change writes only the fields it touches. If you both edit different encounters at the same time, both edits are kept.

**Privacy:** the run ID is 12 random characters and works like an unlisted link. Anyone who has the link can view and edit that run, and nobody can list the other runs. For more protection, turn on Firebase Authentication and tighten the rules.

## Running locally

ES modules don't load from `file://`, so serve the folder:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
