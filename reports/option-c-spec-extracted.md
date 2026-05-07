---
title: Spec Option C — Extraction consolidée
mission: Refonte Option C du système d'annotations
auteur: worker-2 (ANALYST)
date: 2026-05-06
statut: extraction read-only ; aucune interprétation créative
---

# Spec Option C — Extraction consolidée

> **Avertissement de provenance.** Le repo ne contient **aucun fichier source** où la spec utilisateur §1 à §10 apparaisse verbatim sous une numérotation explicite. Seuls les **14 cas §7.1 à §7.14** sont formalisés verbatim (dans `docs/manual-test-checklist.md`). Les sections §1, §2, §3, §4, §5, §6, §8, §9, §10 sont **dérivées** par référence depuis :
>
> - `docs/architecture/annotation-store-v2.md` (architecte APU, 2026-05-06) — restatements partiels avec citations indirectes ("§4 « copy = nouvelle entité »", "§6.2 « duplication implicite interdite »", etc.).
> - `docs/architecture/lot5-migration-plan.md` (idem) — usage opérationnel des §.
> - `.orchestra/round-results/round-1-worker-1.md` (audit précédent) — citation explicite : *"Spec §10 non fournie verbatim ; j'évalue les 5 booléens dérivés directement de §1"*.
> - `INSTRUCTIONS_TEST_REEL.md` (racine, non commité) — **autre spec, plus ancienne**, structurée en "10 circonstances", PAS la même numérotation que §7.1-§7.14.
>
> Chaque section §X ci-dessous porte un **bandeau de provenance** : `VERBATIM` (cité tel quel), `DÉRIVÉ` (reformulé d'après audits/architecture), ou `INTROUVABLE` (à valider auprès de l'utilisateur).

---

## 0. Inventaire des sources

Fichiers du repo contenant des références directes à la spec (`§`, `lot`, `7.1`-`7.14`, `Option C`) :

| Fichier | Type | Pertinence | Contenu |
|---|---|---|---|
| `docs/manual-test-checklist.md` | Spec test | **PRIMAIRE** | §7.1 à §7.14 verbatim avec setups TS, steps, attendus, pass-criteria |
| `docs/architecture/annotation-store-v2.md` | Architecture | SECONDAIRE | §0-§10 sections d'architecture (PAS la spec utilisateur) ; référence §4, §6.2, §7.5, §7.6 indirectement |
| `docs/architecture/lot5-migration-plan.md` | Architecture | SECONDAIRE | Récapitule "scénarios §7.x" en table |
| `docs/architecture/consumer-migration-map.md` | Audit code | TERTIAIRE | Aucune mention §1-§10 ; mapping de code |
| `.orchestra/round-results/round-1-worker-1.md` | Audit | DÉRIVÉ | Matrice §7.1-§7.14 + dérivation §1 (5 contraintes), §6 (6 états interdits), §10 (5 critères) |
| `.orchestra/round-results/round-1-worker-2.md` | Audit | DÉRIVÉ | Faisabilité API VS Code par § |
| `.orchestra/round-results/round-3 à round-8 *.md` | Lots | RÉFÉRENTIEL | Citations §X.Y pour PR/lots livrés |
| `INSTRUCTIONS_TEST_REEL.md` | Spec test (legacy) | **DIVERGENT** | "10 circonstances" — ancienne spec, **PAS §7.1-§7.14**, structure différente |
| `CLAUDE.md` | Project | NUL | Aucune mention Option C / §1-§10 |
| `CHANGELOG.md` | Release | NUL | Aucune mention Option C |
| `.claude/undo-snapshots.json` | Runtime | NUL | Snapshots editor seulement |
| `.orchestra/active-mission.json` | Mission | RÉFÉRENTIEL | Cite « §1-§10, 14 cas de test §7.1-§7.14 » sans contenu |
| `.orchestra/sessions/2026-05-06T21-06-41.jsonl` | Session | RÉFÉRENTIEL | Mission texte tronqué — citation utilisateur partielle (« personne n'a encore utilisé les ancres, c'est nouveau, ca doit être parfait, …») |

**Constat clé** : aucun fichier n'expose le texte intégral utilisateur de §1-§10. Le mission texte dans `active-mission.json` cite `« §1-§10, 14 cas de test §7.1-§7.14 »` mais le contenu textuel des §1-§10 n'est conservé nulle part. Voir `## Statut spec` en fin de document.

---

## 1. Extraction §1 à §10

### §1 — Contraintes absolues *(DÉRIVÉ — non verbatim)*

> **Source** : dérivée de `.orchestra/round-results/round-1-worker-1.md` §2 « Évaluation des 5 contraintes absolues §1 ».
> **Citation indirecte** (round-1-worker-1.md ligne 34-44).

Cinq contraintes absolues (selon dérivation worker-1 de round 1) :

| ID | Contrainte (libellé dérivé) | AC testable |
|---|---|---|
| **§1.1** | Aucune dérive de position | AC-1.1 : pour toute mutation `(file, range)`, la position résolue d'une annotation après mutation est *exacte* (pas de glissement heuristique). |
| **§1.2** | Aucune duplication implicite | AC-1.2 : aucune nouvelle annotation ne peut être créée sans intent utilisateur explicite (commande UI ou geste qualifié comme paste-after-copy). |
| **§1.3** | Aucune persistance après suppression du code source | AC-1.3 : si la ligne ancrée est supprimée et qu'aucune action de restauration (paste-after-cut, undo) ne survient dans le délai TTL, l'annotation passe à `disposed` et n'est plus persistée ni affichée. |
| **§1.4** | Aucune dépendance à la position du curseur (path création + tracking) | AC-1.4 : `addAnnotation` doit accepter un argument `{line}` ou `{offset}` explicite ; pas de fallback silencieux à `editor.selection.active.line` (round-1-worker-1.md ligne 41 : *"strict reading : violée sur le path de création"*). |
| **§1.5** | Cohérence totale avec undo/redo | AC-1.5 : tout undo/redo VS Code qui touche le contenu d'une annotation est mirroré dans le store annotation (état restauré exact, ID préservé). |

> **Ambiguïté** : `round-1-worker-1.md` ligne 5 cite « §1 contraintes » sans verbatim. Le compte « 5 » est une déduction de l'auditeur. À valider auprès de l'utilisateur.

### §2 — Ancrage par offset *(DÉRIVÉ — référence indirecte)*

> **Source** : `docs/architecture/annotation-store-v2.md` §0 et §3 ; `.orchestra/round-results/round-1-worker-2.md` §2 « FAISABLE » sur `(startOffset, endOffset)`.

Exigences impératives dérivées :

| ID | Exigence | AC testable |
|---|---|---|
| **§2.1** | L'ancrage **doit** être primaire offset-based : `(startOffset, endOffset)` UTF-16 code-units (`AnnotationV2.startOffset`/`endOffset`, `annotation-store-v2.md:88-92`). | AC-2.1 : `AnnotationV2` persiste `startOffset`, `endOffset` ; pas de champ `line` numérique persisté (`annotation-store-v2.md:242` : *"Champ `line` legacy abandonné"*). |
| **§2.2** | L'ancrage **doit** être redondé par `(lineHash, contextBefore, contextAfter)` pour les éditions externes hors process VS Code (limit L3, `annotation-store-v2.md:25`). | AC-2.2 : `lineHash`, `contextBefore[]`, `contextAfter[]` présents pour toute annotation `state === 'active'` (invariant I5). |
| **§2.3** | L'ajustement d'offset à chaque `TextDocumentContentChangeEvent` **doit** suivre les 4 cas A/B/C/D (`annotation-store-v2.md:412-456`). | AC-2.3 : voir matrice §3 ci-dessous. |

### §3 — Modèle transactionnel *(DÉRIVÉ — réf. annotation-store-v2.md §0, §2 limit L1)*

> **Source** : `annotation-store-v2.md:14-26` (tableau des limites) + §3 (algorithme).
> **Citation verbatim** (annotation-store-v2.md:23) : *"L1 : La pile undo VS Code ne peut pas contenir des mutations d'objets extension. mirrorUndo() / mirrorRedo() rejoue/inverse le journal sur réception de event.reason === Undo|Redo."*

| ID | Exigence | AC testable |
|---|---|---|
| **§3.1** | Toute mutation **doit** passer par un `OpEntry` enregistré dans un journal cyclique append-only (`annotation-store-v2.md:160-186`). | AC-3.1 : après tout `add/remove/update/suspend/resume`, `store.getJournal().entries` contient un `OpEntry` avec `before`/`after`/`inverse` cohérents. |
| **§3.2** | Les transactions internes **doivent** être atomiques côté store (`beginTransaction/commit/rollback`, `annotation-store-v2.md:347-349`). | AC-3.2 : un `rollback()` après `add` partiel ne laisse aucune trace dans la map ni le journal. |
| **§3.3** | L'atomicité avec la pile undo de VS Code n'est **pas** native (limit L1) ; elle **doit** être émulée via `event.reason === Undo|Redo` (mirrorUndo/mirrorRedo). | AC-3.3 : un undo VS Code après mutation annotation déclenche `mirrorUndo` qui inverse l'OpEntry pointée par cursor. |

**4 cas d'ajustement d'offset** (annotation-store-v2.md:412-456, verbatim) :

| Cas | Condition | Action sur `(startOffset, endOffset)` |
|---|---|---|
| **A** | `R1 <= A0` (édition strictement avant) | `startOffset += delta ; endOffset += delta` |
| **B** | `R0 >= A1` (édition strictement après) | no-op |
| **C** | `R0 >= A0 && R1 <= A1` (intra-annotation) | `endOffset += delta` |
| **D** | recouvrement partiel ou total | `suspend(ann.id, blockHash)` |

(`R0 = change.rangeOffset`, `R1 = R0 + change.rangeLength`, `delta = change.text.length - change.rangeLength`, `A0 = ann.startOffset`, `A1 = ann.endOffset`.)

### §4 — Sémantique copy = nouvelle entité *(DÉRIVÉ — référence indirecte)*

> **Source** : `annotation-store-v2.md:670-678` D1, citation indirecte : *"§4 décrit une duplication explicite, intentionnelle, avec sémantique claire (l'utilisateur veut deux annotations à deux endroits)"*.
> **Aussi** : `round-1-worker-1.md:39-40` et `:53` (*"§4 ('copy = new entity')"*).

| ID | Exigence | AC testable |
|---|---|---|
| **§4.1** | Un copy + paste **doit** produire une **nouvelle annotation** avec UUID v4 distinct (pas le même ID que la source). | AC-4.1 : après §7.6, deux annotations dans le store, deux IDs différents (`docs/manual-test-checklist.md:155-157` *"UUID **différent**"*). |
| **§4.2** | La nouvelle annotation **doit** porter `origin.kind === 'paste'` et `origin.sourceOpId` pointant vers l'OpEntry de l'add source. | AC-4.2 : `(clone.origin.kind === 'paste') && (store.getJournal().entries.find(e => e.opId === clone.origin.sourceOpId).kind === 'add')`. |
| **§4.3** | L'annotation source **doit** rester intacte (position, ID, message). | AC-4.3 : §7.6 expected, ligne 156 : *"original toujours ligne 1"*. |

### §5 — Mirror undo/redo *(DÉRIVÉ — réf. annotation-store-v2.md §2 limit L1)*

> **Source** : `annotation-store-v2.md:23` + `:351-363` (mirrorUndo/mirrorRedo signatures).

| ID | Exigence | AC testable |
|---|---|---|
| **§5.1** | `applyDocumentChange` **doit** invoquer `mirrorUndo` quand `event.reason === vscode.TextDocumentChangeReason.Undo`. | AC-5.1 : test EDH §7.7 — undo après paste retire le clone du tree. |
| **§5.2** | `applyDocumentChange` **doit** invoquer `mirrorRedo` quand `event.reason === vscode.TextDocumentChangeReason.Redo`. | AC-5.2 : test EDH §7.8 — redo restaure le clone avec **MÊME ID** (`docs/manual-test-checklist.md:193`). |
| **§5.3** | L'alignement avec la pile undo de l'éditeur **doit** utiliser `documentVersionAtOp` enregistré sur chaque `OpEntry` (`annotation-store-v2.md:178-180`). | AC-5.3 : test unitaire mirrorUndo replay positionne cursor selon `documentVersionAtOp`. |

### §6 — États interdits *(DÉRIVÉ — non verbatim)*

> **Source** : `.orchestra/round-results/round-1-worker-1.md` §3 « Évaluation des 6 états interdits §6 », ligne 48-59.

Six états interdits (libellés dérivés de l'audit worker-1) :

| ID | État interdit | AC testable |
|---|---|---|
| **§6.1** | Annotation orpheline (status `orphaned` persistant) | AC-6.1 : aucune `AnnotationV2` ne porte un état `orphaned` ; les états valides sont `active`, `suspended`, `disposed` (`annotation-store-v2.md:48`). |
| **§6.2** | Annotation dupliquée (deux entrées même ID) | AC-6.2 : invariant I1 « unicité ID » validé par `store.validate()`. *Note : §6.2 vise la duplication **implicite** (bug interne), distincte de §4 duplication explicite — voir D1 dans annotation-store-v2.md:669.* |
| **§6.3** | Annotation déplacée sans action liée | AC-6.3 : aucune mutation de `(startOffset, endOffset)` n'est consignée dans le journal sans un `OpEntry` correspondant à un `change` reçu. |
| **§6.4** | Annotation persistante après suppression du code source | AC-6.4 : voir §1.3. Après TTL d'orphelin (suspended → disposed), l'annotation n'est plus présente dans `serialize()`. |
| **§6.5** | Annotation déclenchée par mouvement du curseur | AC-6.5 : aucun listener `onDidChangeTextEditorSelection` n'invoque de mutation sur le store (round-1-worker-1.md:56 : *"tracking ne dépend pas du curseur"*). |
| **§6.6** | Triggered par autre que transformation de doc | AC-6.6 : `onDidChangeVisibleTextEditors`, `onDidChangeActiveTextEditor`, `onDidOpenTextDocument` ne mutent pas l'état persistant des annotations (round-1-worker-1.md:57). |

### §7 — Cas de test §7.1 à §7.14 *(VERBATIM — voir section dédiée §3 ci-dessous)*

> **Source** : `docs/manual-test-checklist.md` lignes 14-356 — verbatim.

Voir matrice détaillée en **section 3 « Extraction des 14 cas §7.1 à §7.14 »** ci-dessous.

### §8 — Persistence et schéma *(DÉRIVÉ — réf. annotation-store-v2.md §5)*

> **Source** : `annotation-store-v2.md:528-590` (format JSON v2 + notes).

| ID | Exigence | AC testable |
|---|---|---|
| **§8.1** | Le fichier persisté **doit** être `<workspace>/.out-of-code-insights/annotations.json` au format JSON v2. | AC-8.1 : `serialize()` retourne `{schemaVersion: 2, annotations: AnnotationV2[]}`. |
| **§8.2** | `schemaVersion` **doit** être `=== 2` ; toute autre valeur en lecture déclenche une erreur (pas de migration). | AC-8.2 : `deserialize({schemaVersion: 1, …})` throws. |
| **§8.3** | Le journal et le buffer suspendu **ne sont pas** persistés disque (volatiles, perdus à la fermeture). | AC-8.3 : annotation-store-v2.md:587 — *"un cut suivi d'un reload de fenêtre passe les annotations recouvertes à `disposed` au prochain sweep"*. Acceptable comme dégradation Phase 1. |
| **§8.4** | Les entrées `disposed` **ne sont pas** sérialisées. | AC-8.4 : annotation-store-v2.md:392 *"Disposed entries are excluded"*. |
| **§8.5** | Les annotations `suspended` doivent rester dans `serialize()` (visible dans JSON, absentes du tree). | AC-8.5 : §7.14 *"`to-cut` reste suspended (visible dans `.out-of-code-insights/annotations.json` avec `state: 'suspended'`)"* (manual-test-checklist.md:347-348). |

### §9 — Conventions et qualité *(DÉRIVÉ — réf. annotation-store-v2.md §9)*

> **Source** : `annotation-store-v2.md:701-715`. Cohérent avec `CLAUDE.md` section "Conventions".

| ID | Exigence | AC testable |
|---|---|---|
| **§9.1** | TypeScript strict, aucun `any`, retours typés. | AC-9.1 : `npm run typecheck` ✓ ; `tsc --noEmit` zéro erreur. |
| **§9.2** | ESLint `--max-warnings 0`. | AC-9.2 : `npm run lint:ci` ✓. |
| **§9.3** | Header SPDX `MPL-2.0` en tête de chaque nouveau fichier. | AC-9.3 : grep `// SPDX-License-Identifier: MPL-2.0` dans `src/transactional/**`. |
| **§9.4** | Pas de `console.log` ; logging via `getLogger()`. | AC-9.4 : grep négatif `console\.log` hors tests. |
| **§9.5** | Conventional Commits par lot (`feat(transactional): …`, `refactor(annotations): …`). | AC-9.5 : `git log` montre les 7 lots avec préfixes conformes. |
| **§9.6** | Coverage c8 ≥ thresholds (lignes/fonctions 15, branches 10). | AC-9.6 : `npm run coverage:check` ✓. |

### §10 — Critères d'acceptation *(DÉRIVÉ — non verbatim)*

> **Source** : `.orchestra/round-results/round-1-worker-1.md` §4 « Critères d'acceptation §10 (booléens) », lignes 63-77. Citation explicite : *"Spec §10 non fournie verbatim ; j'évalue les 5 booléens dérivés directement de §1 (les critères d'acceptation suivent typiquement les contraintes absolues)"*.

Cinq critères booléens dérivés (à valider auprès de l'utilisateur) :

| # | Critère (dérivé §1) | Booléen attendu |
|---|---|---|
| **§10.1** | Aucune dérive de position observable | true |
| **§10.2** | Aucune duplication implicite (sans intent utilisateur) | true |
| **§10.3** | Aucune persistance après suppression source | true |
| **§10.4** | Aucune dépendance curseur dans le tracking | true |
| **§10.5** | Undo/redo cohérent (réversibilité totale) | true |

> **Ambiguïté §10** : ces 5 critères sont une **dérivation directe de §1**. Le worker-1 audit ligne 77 : *"Si §10 contient des critères différents de §1, ce score peut diverger ; le rapport reste valable structurellement"*. À confirmer par l'utilisateur.

---

## 2. Extraction des 14 cas §7.1 à §7.14

> **Source** : `docs/manual-test-checklist.md` lignes 14-356 (VERBATIM, copier-coller intégral des setups, steps, attendus). Fixtures et tests cross-référencés depuis `test-fixtures/` et `src/test/suite/`.

### §7.1 — Insertion AVANT la ligne ancrée

- **Pré-condition** : fichier TS avec 4 lignes, annotation `target-anno` sur ligne 4 (verbatim setup `manual-test-checklist.md:18-23`).
- **Action** : curseur ligne 0, insérer 3 lignes vides (Enter × 3 au début).
- **Attendu** : `target-anno` est sur ligne 7. Tree reflète `Line 7`. Aucune annotation fantôme.
- **Pass criteria** : annotation a suivi le code (offset shifted) ; aucune annotation fantôme.
- **Fixture** : `test-fixtures/lot1-7-1-insertion-before.ts` ✓
- **Test associé** : `src/test/suite/annotationStore.integration.test.ts` (citation worker-2 round-1) ; `src/test/suite/lot5-runtime.integration.test.ts` (probable couverture indirecte).

### §7.2 — Insertion SUR la ligne ancrée

- **Pré-condition** : fichier TS 1 ligne `const TARGET = 1;` ; annotation `partial-anno` ancrée sur sub-string `TARGET = 1` (ligne 0).
- **Action** : curseur ligne 0 colonne 0 (avant `c` de `const`), taper `// `.
- **Attendu** : ligne devient `// const TARGET = 1;`. Annotation reste sur `Line 0`. Hover/decoration couvre toujours `TARGET = 1`.
- **Pass criteria** : annotation reste sur la même ligne (line index inchangé) ; startOffset/endOffset shiftés du delta inséré (`3` chars).
- **Fixture** : `test-fixtures/lot1-7-2-insertion-on-line.ts` ✓
- **Test associé** : `src/test/suite/annotationStore.integration.test.ts` (cas A/C `applyDocumentChange`).

### §7.3 — Suppression de la ligne ancrée

- **Pré-condition** : 3 lignes ; annotation `delete-target` sur ligne 1.
- **Action** : sélectionner ligne 1 entière puis `Delete`. Attendre 30 s (TTL par défaut). Faire un autre edit (espace ailleurs).
- **Attendu** :
  - Immédiat : annotation disparaît du tree, panneau ne la liste plus.
  - Après TTL : annotation est `disposed`, **n'apparaît à AUCUNE autre position**.
- **Pass criteria** : pas de relocation automatique (interdit par spec) ; pas d'annotation fantôme dans le tree.
- **Fixture** : `test-fixtures/lot4-7-3-delete-anchored-line.ts` ✓
- **Test associé** : couverture `lot4` cut/suspended (pas de fichier `lot4-*.integration.test.ts` distinct trouvé ; couvert par `annotationStore.integration.test.ts`).

### §7.4 — Cut sans paste

- **Pré-condition** : 3 lignes ; annotation `cut-orphan` sur ligne 1.
- **Action** : `Ctrl+L` (sélectionner ligne) puis `Ctrl+X` (cut). Ne PAS coller. Attendre 30 s. Faire un autre edit.
- **Attendu** :
  - Immédiat : annotation disparaît du tree (état `suspended` sous le capot).
  - Après TTL : annotation reste absente du tree (TTL → disposed).
- **Pass criteria** : annotation pas déplacée vers la ligne où le contenu a été coupé ; tree vide après TTL.
- **Fixtures** : `test-fixtures/lot4-7-4-cut-no-paste.ts` ✓ + `test-fixtures/lot4-7-4-ttl-expiry.ts` ✓ (deux variantes : geste + expiry).
- **Test associé** : couvert par tests `annotationStore.integration.test.ts` (cas D + suspended).

### §7.5 — Paste après cut

- **Pré-condition** : 4 lignes ; annotation `cut-paste-victim` sur ligne 1.
- **Action** : cut ligne 1 ; curseur ligne 3 ; `Ctrl+V`.
- **Attendu** : `cut-paste-victim` réapparaît dans le tree à la nouvelle ligne. **MÊME ID** que avant le cut.
- **Pass criteria** : pas de duplication (toujours une seule annotation) ; ID préservé ; position correcte.
- **Fixture** : `test-fixtures/lot4-7-5-paste-after-cut.ts` ✓
- **Test associé** : couvert par tests `annotationStore.integration.test.ts` (resume).

### §7.6 — Copy + paste : 2 annotations distinctes

- **Pré-condition** : 4 lignes ; annotation `original` sur ligne 1.
- **Action** : `Ctrl+L` + `Ctrl+C` (copy, pas cut) ; curseur ligne 3 ; `Ctrl+V`.
- **Attendu** : 2 annotations dans le tree :
  - `original` toujours ligne 1.
  - Nouvelle annotation au site collé (UUID **différent**, `origin.kind === 'paste'`, `message === 'original'`).
- **Pass criteria** : original intact, position inchangée ; clone créé avec nouvel ID ; `origin.sourceOpId` pointe vers l'op d'add originale.
- **Fixture** : `test-fixtures/lot4-7-6-copy-paste.ts` ✓
- **Test associé** : `lot5-managers.integration.test.ts` (Linked) ; couverture spécifique non confirmée.

### §7.7 — Undo après paste

- **Pré-condition** : reproduire §7.6 (copy + paste → 2 annotations).
- **Action** : `Ctrl+Z` (undo).
- **Attendu** : l'annotation collée disparaît du tree. L'originale reste à ligne 1.
- **Pass criteria** : tree affiche 1 annotation (l'originale) ; le clone n'est récupérable que via `Ctrl+Y` (redo).
- **Fixture** : `test-fixtures/lot2-7-7-undo-paste.ts` ✓
- **Test associé** : tests EDH undo (round-3 worker-1 mention `mirrorUndo`).

### §7.8 — Redo restaure après undo

- **Pré-condition** : reproduire §7.7 (after undo → 1 annotation).
- **Action** : `Ctrl+Y` (redo).
- **Attendu** : le clone réapparaît avec **MÊME ID** qu'avant l'undo, **mêmes offsets**.
- **Pass criteria** : tree affiche 2 annotations ; ID du clone inchangé entre l'undo et le redo (vérifier JSON).
- **Fixture** : `test-fixtures/lot2-7-8-redo-paste.ts` ✓
- **Test associé** : `mirrorRedo` tests.

### §7.9 — Undo cut+paste rollback

- **Pré-condition** : 4 lignes ; annotation `roundtrip` sur ligne 1.
- **Action** : cut ligne 1, paste ligne 3 ; pré-undo : annotation à la nouvelle ligne. `Ctrl+Z` (annule paste). `Ctrl+Z` (annule cut).
- **Attendu** : annotation est de retour à la ligne 1 originale, **MÊME ID**.
- **Pass criteria** : état identique au point de départ (offsets, ID, message) ; pas de duplication.
- **Fixture** : `test-fixtures/lot2-7-9-undo-cut-paste.ts` ✓
- **Test associé** : tests EDH undo (round-3 worker-1).

### §7.10 — Multi-paste : N instances indépendantes

- **Pré-condition** : annotation `multi-source` sur ligne 1 ; lignes vides 2-10.
- **Action** : copy (`Ctrl+L` + `Ctrl+C`) ; coller à 3 endroits (lignes 3, 6, 9) — trois `Ctrl+V` séparés.
- **Attendu** : 4 annotations dans le tree :
  - `multi-source` original ligne 1.
  - 3 clones, chacun avec UUID distinct et `origin.kind === 'paste'`.
- **Pass criteria** : total 4 entries ; UUIDs deux à deux distincts ; 3 clones marqués `origin.kind === 'paste'`.
- **Fixture** : `test-fixtures/lot4-7-10-multi-paste.ts` ✓
- **Test associé** : tests EDH paste-multi.

### §7.11 — Sélection partielle (sub-line copy/cut)

- **Pré-condition** : annotation `full-line-anno` ancrée sur la ligne 0 entière.
- **Action** : sélectionner UN FRAGMENT de la ligne 0 (par exemple `= 1`) ; `Ctrl+C` ; coller ligne 1 fin.
- **Attendu** : 1 SEULE annotation (`full-line-anno`). Le fragment collé **n'a pas créé de clone** (hash de la ligne complète ne matche pas le fragment).
- **Pass criteria** : pas de duplication incohérente ; annotation originale intacte.
- **Fixture** : `test-fixtures/lot4-7-11-partial-line-paste.ts` ✓

### §7.12 — Suppression bloc multi-lignes

- **Pré-condition** : 4 lignes ; annotations `block-1` (ligne 1) et `block-2` (ligne 2).
- **Action** : sélectionner lignes 1-2 ; `Delete`.
- **Attendu** : les 2 annotations disparaissent du tree (immédiat).
- **Pass criteria** : tree vide ; pas de fantôme à une autre ligne.
- **Fixture** : `test-fixtures/lot4-7-12-block-delete.ts` ✓

### §7.13 — Déplacement bloc cut+paste : IDs conservés

- **Pré-condition** : 6 lignes ; annotations `block-1` (ligne 1) et `block-2` (ligne 2). Capturer leurs IDs.
- **Action** : sélectionner lignes 1-2 ; `Ctrl+X` ; curseur ligne 5 ; `Ctrl+V`.
- **Attendu** : 2 annotations dans le tree, aux nouvelles lignes (lignes 5 et 6 post-shift). **MÊMES IDs** que avant le cut.
- **Pass criteria** : IDs préservés ; position correcte ; ordre préservé (block-1 avant block-2).
- **Fixture** : `test-fixtures/lot4-7-13-block-cut-paste.ts` ✓

### §7.14 — Save / reload : état cohérent

- **Pré-condition** : reproduire §7.6 (1 annotation active + 1 clone) + cut une 3ème annotation pour la mettre en `suspended` (sans paste).
- **Action** :
  1. Annoter ligne 0 → `active-1`.
  2. Annoter ligne 5 → `to-cut`.
  3. Cut ligne 5 (annotation `to-cut` passe en suspended).
  4. Annoter ligne 8 → `active-2` puis `Edit annotation` pour modifier le message en `active-2-edited`.
  5. `Ctrl+S` pour sauvegarder.
  6. Fermer la fenêtre EDH puis relancer F5 et rouvrir le même fichier.
- **Attendu** :
  - Tree affiche `active-1` et `active-2-edited` (2 actives).
  - `to-cut` reste suspended (visible dans `.out-of-code-insights/annotations.json` avec `state: 'suspended'`, mais pas dans le tree).
  - Coller le contenu de `to-cut` ailleurs → l'annotation ré-apparaît avec son ID original (paste-resume).
- **Pass criteria** : aucune annotation fantôme à des positions imprévues ; IDs préservés à travers le save/reload ; le message le plus récent (`active-2-edited`) est celui restauré ; `schemaVersion: 2` présent dans le JSON persisté.
- **Fixture** : `test-fixtures/lot4-7-14-save-reload.ts` ✓

---

## 3. Invariants transverses

> Règles qui s'appliquent à plusieurs cas, dérivées de la lecture combinée des sources.

| ID | Invariant | Cas concernés | Source |
|---|---|---|---|
| **INV-1** | **TTL d'orphelins (suspended → disposed)** = **30 000 ms** par défaut, configurable via `outOfCodeInsights.suspendedTtlMs`. | §7.3, §7.4 | `annotation-store-v2.md:496` ; `manual-test-checklist.md:78,103` *"30 s (TTL par défaut)"* |
| **INV-2** | **Préservation d'ID** sur paste-after-cut (resume), undo, redo. | §7.5, §7.7, §7.8, §7.9, §7.13, §7.14 | `manual-test-checklist.md:128,193,219,321` *"MÊME ID"* |
| **INV-3** | **Pas de relocation silencieuse** : aucune annotation ne peut migrer à une nouvelle ligne sans une opération journalisée explicite (§3.1) ou un cut/paste apparié (§4). | §7.3, §7.4, §7.12 | `manual-test-checklist.md:81` *"Pas de relocation automatique (interdit par spec)"* |
| **INV-4** | **Origin chain pour paste-after-copy** : tout clone copy+paste porte `origin.kind === 'paste'` + `origin.sourceOpId` résolvable dans le journal (invariant I6 du store). | §7.6, §7.10, §7.14 | `annotation-store-v2.md:387` ; `manual-test-checklist.md:160` |
| **INV-5** | **Idempotence undo/redo** : un cycle Ctrl+Z puis Ctrl+Y restaure exactement l'état (mêmes IDs, mêmes offsets). | §7.7, §7.8, §7.9 | `manual-test-checklist.md:193` *"même ID, mêmes offsets"* |
| **INV-6** | **schemaVersion === 2** : refus strict en lecture/écriture. | §7.14, §8 | `annotation-store-v2.md:399` |
| **INV-7** | **Annotations `disposed` exclues de la sérialisation** ; annotations `suspended` incluses dans le JSON mais absentes du tree. | §7.3, §7.4, §7.14 | `manual-test-checklist.md:347-348` ; `annotation-store-v2.md:392` |
| **INV-8** | **Pas de hash collision créateur de duplication implicite** : §7.11 (sélection partielle) ne déclenche pas de clone. La détection paste-after-cut/copy exige un match `blockHash` exact sur la ligne complète normalisée. | §7.11 | `manual-test-checklist.md:267` *"hash de la ligne complète ne matche pas le fragment"* |
| **INV-9** | **`add` exige `line` XOR `offset`** (jamais ni 0 ni 2). | §7.1, §7.2 (création) | `annotation-store-v2.md:294-300` *"Contract: exactly ONE of opts.line or opts.offset MUST be provided. Passing neither — or both — throws RangeError"* |
| **INV-10** | **Pas de persistance journal/buffer suspendu** entre redémarrages : un cut suivi d'un reload de fenêtre passe les annotations suspended à disposed au prochain sweep (limite acceptée Phase 1). | §7.4, §7.14 | `annotation-store-v2.md:587` |
| **INV-11** | **Ordre d'application des `contentChanges`** : `vscode.TextDocumentChangeEvent.contentChanges` livré en **ordre inverse** des positions. `applyDocumentChange` itère dans l'ordre fourni sans cumul de delta entre changes. | §7.12, §7.13 | `annotation-store-v2.md:472-474` |
| **INV-12** | **Walking lors de la création** : `captureAnchor` est invoqué avec `walkForward: 0 / walkBackward: 0` lors d'un refresh post-edit (l'offset est l'autorité), mais peut walker à la création (pour les lignes vides). | §7.2 | `annotation-store-v2.md:469-470` |

---

## 4. Ambiguïtés détectées

Liste numérotée des points où la spec est vague, contradictoire, ou doit être confirmée par l'utilisateur.

### A1 — §1, §6, §10 jamais fournies verbatim

**Constat** : aucun fichier du repo ne contient le texte original utilisateur de §1 (5 contraintes), §6 (6 états interdits), §10 (5 critères d'acceptation). Toutes les versions présentes sont **dérivées** par l'auditeur worker-1 round-1.

**Risque** : la dérivation peut omettre une contrainte ou un état que l'utilisateur considère comme bloquant.

**Question utilisateur** : peux-tu fournir le texte verbatim de §1, §6 et §10 (ou confirmer que les dérivations ci-dessus correspondent à ton intention) ?

---

### A2 — §6.2 (duplication interdite) vs §4 (copy = nouvelle entité)

**Constat** : `annotation-store-v2.md:670-678` D1 traite cette tension. La décision retenue par l'architecte : §6.2 vise la duplication *implicite* (bug interne), §4 décrit une duplication *explicite* (intent utilisateur). Les deux sont compatibles via `origin.kind` + `sourceOpId` distincts.

**Risque** : si l'utilisateur a une lecture stricte de §6.2 (« aucune annotation ne peut être créée avec un contenu identique à une autre »), §7.6 est non-spec.

**Question utilisateur** : confirmer la lecture de l'architecte (§4 prévaut sur §6.2 quand l'utilisateur clique paste avec intent explicite) ou imposer une autre règle (par exemple : prompt Yes/No avant duplication, comme l'ancien `INSTRUCTIONS_TEST_REEL.md` Circonstance 5) ?

---

### A3 — TTL d'orphelins : 5 s vs 30 s

**Constat** : l'ancien `INSTRUCTIONS_TEST_REEL.md` Circonstance 3-4 cite un TTL de **5 secondes** (`clipboardWindowMs`). La nouvelle `manual-test-checklist.md` §7.3 cite **30 secondes** (`suspendedTtlMs`). `annotation-store-v2.md:496` aligne sur 30 s.

**Risque** : changement de comportement non documenté dans le CHANGELOG. Test §7.3 attend 30 s ; un utilisateur habitué aux 5 s pourrait croire à un freeze.

**Question utilisateur** : confirmer que le TTL Phase 1 est bien 30 s (et que `INSTRUCTIONS_TEST_REEL.md` est obsolète) ?

---

### A4 — `INSTRUCTIONS_TEST_REEL.md` vs `manual-test-checklist.md` : deux specs en parallèle

**Constat** : `INSTRUCTIONS_TEST_REEL.md` décrit "10 circonstances" (insertion, suppression, cut+paste, copy+paste, drag-and-drop, undo/redo, edition externe, refactor LSP, rename fichier, retrocompat). `manual-test-checklist.md` décrit "14 cas §7.1-§7.14" avec une numérotation et une logique différentes.

**Divergences précises** :

| Sujet | `INSTRUCTIONS_TEST_REEL.md` | `manual-test-checklist.md` |
|---|---|---|
| Suppression ligne | Buffer 5 s + dialog si pas paste (`Delete annotation` / `Keep at nearest line` / `Cancel`) | TTL 30 s, **disposed silencieux**, pas de dialog |
| Copy + paste | Prompt Yes/No (`Copy it to the new location?`) | Pas de prompt, clone créé directement avec `origin.kind === 'paste'` |
| Edition externe | `findAnchor` relocalise par hash + contexte | Pas couvert (§7.x silencieux sur ce cas) |
| Rename fichier | `handleFileRename` met à jour `annotation.file` | Pas couvert (§7.x silencieux) |
| Drag-and-drop panneau | Réorganisation par index, `setAnnotationLine` | Pas couvert (§7.x silencieux) |

**Risque** : si l'utilisateur considère que `INSTRUCTIONS_TEST_REEL.md` reste valide, plusieurs comportements (dialogs, prompts, rename, drag-and-drop) doivent être ajoutés à la spec Option C.

**Question utilisateur** : `INSTRUCTIONS_TEST_REEL.md` est-il **obsolète** (remplacé intégralement par `manual-test-checklist.md` §7.x) ou **complémentaire** (les comportements UI dialogs/prompts/rename restent attendus en plus de §7.x) ?

---

### A5 — §3 contraint « atomique texte+annotation » : structurellement non faisable

**Constat** : `round-1-worker-2.md:84-88` cite `index.d.ts:1275-1284, :13688, :3899-3905` pour démontrer que VS Code n'expose **aucune API** permettant d'inclure une mutation d'objet extension dans la pile undo native. La limite L1 (`annotation-store-v2.md:23`) reconnaît cette contrainte et propose un mirroring best-effort.

**Risque** : si §3 utilisateur exige une atomicité stricte (rollback texte + annotation atomique), la spec est **structurellement non-spec** sous l'API VS Code 1.95.0.

**Question utilisateur** : accepter la dégradation L1 (mirror best-effort via `event.reason === Undo|Redo`) comme conforme à §3, ou exiger une autre approche (ex. désactivation du mirroring au profit d'un confirm dialog) ?

---

### A6 — §1.4 : curseur en création (path UI)

**Constat** : `round-1-worker-1.md:41` souligne que le code actuel (`addAnnotation:1642`) lit `editor.selection.active.line` par défaut. La dérivation §1.4 dit *"Aucune dépendance à la position du curseur"*.

**Lecture stricte** : le path création UI (`Annotations: Add annotation`) doit refuser le curseur et exiger un argument `{line}` explicite. Cela casserait l'UX actuelle (clic droit → Add annotation → fonctionne).

**Lecture pragmatique** : §1.4 ne s'applique qu'au **tracking** (post-création), pas au geste utilisateur initial.

**Question utilisateur** : §1.4 s'applique-t-il à la création ou seulement au tracking ?

---

### A7 — §7.x silencieux sur l'edition externe et le rename

**Constat** : aucun cas §7.x ne couvre l'édition externe (Notepad, autre éditeur) ni le rename de fichier ni le LSP F2 rename.

**Risque** : ces comportements existaient dans `INSTRUCTIONS_TEST_REEL.md` Circonstances 8/9/10. S'ils restent attendus, ils doivent être ajoutés à §7.x ou couverts par §X séparée.

**Question utilisateur** : faut-il ajouter §7.15 (édition externe), §7.16 (rename fichier), §7.17 (LSP rename) ? Ou confirmer qu'ils sont hors scope Option C Phase 1 ?

---

### A8 — `INV-1` TTL configurable mais pas dans `package.json`

**Constat** : `annotation-store-v2.md:496` cite la config `outOfCodeInsights.suspendedTtlMs` mais cette clé **n'est pas** présente dans `package.json` (vérifié par grep — non confirmé in-context). Si le test §7.3 attend le 30 s par défaut, la config doit être déclarée pour être surchargeable.

**Question utilisateur** : `outOfCodeInsights.suspendedTtlMs` doit-il être exposé en config utilisateur (`package.json` `contributes.configuration`) ou rester un constante interne du store ?

---

### A9 — Capacité du journal : 200 (lot brief) vs 1024 (architecture)

**Constat** : `round-3-worker-1.md:27` cite la divergence entre le brief de Lot 1 (« default 200 ») et `annotation-store-v2.md:192-194` (« default 1024 »). Worker-1 a retenu 1024 conformément au doc d'architecture.

**Question utilisateur** : confirmer la capacité par défaut du journal cyclique (200, 1024, ou autre) ?

---

### A10 — Persistance journal et buffer suspendu (limit volatile Phase 1)

**Constat** : `annotation-store-v2.md:587` documente que le journal et le buffer suspendu **ne sont pas** persistés disque. Conséquence : un cut suivi d'un reload passe les annotations à `disposed`. Documenté comme "dégradation acceptable Phase 1".

**Risque** : §7.14 expected ligne 349 attend que `to-cut` reste suspended dans `.out-of-code-insights/annotations.json` après reload. Cela contredit la dégradation Phase 1 si le suspended buffer n'est pas persisté.

**Question utilisateur** : §7.14 exige-t-il vraiment la persistance disque du buffer suspendu (donc ré-implémenter la persistance journal/buffer Phase 1) ou peut-on dégrader le test en `disposed` après reload ?

---

## Statut spec

**Statut** : **partiellement trouvée**.

- **§7.1 à §7.14** : trouvée intégralement et verbatim dans `docs/manual-test-checklist.md`. Fixtures `test-fixtures/lot{1,2,4}-7-*.ts` toutes présentes pour les 14 cas (16 fichiers `lot*-7-*.ts`, deux variantes pour §7.4).
- **§3, §4, §5, §8, §9** : trouvées par référence dans `docs/architecture/annotation-store-v2.md` (dérivation cohérente, citations indirectes). Acceptables comme spec opérationnelle après validation utilisateur.
- **§1, §6, §10** : **introuvables verbatim**. Présentes uniquement dans `.orchestra/round-results/round-1-worker-1.md` sous forme dérivée par l'auditeur. La citation explicite ligne 65 dit *"Spec §10 non fournie verbatim"*.
- **§2** : trouvée par référence dans `annotation-store-v2.md:88-92` et round-1-worker-2.md ; cohérent.

**Conclusion** : le contrat d'acceptation est exécutable pour les 14 cas §7.x et pour les sections architecture (§2-§5, §8-§9). Les sections §1, §6, §10 doivent être confirmées par l'utilisateur avant d'être utilisées comme arbitre des décisions de design (notamment l'ambiguïté §4 vs §6.2 et le périmètre de §1.4).

---

## Questions ouvertes

1. **A1** — Peux-tu fournir le texte verbatim de §1 (5 contraintes), §6 (6 états interdits) et §10 (5 critères d'acceptation), ou confirmer que les dérivations de `round-1-worker-1.md` correspondent à ton intention ?
2. **A2** — §4 « copy = nouvelle entité » prévaut-il sur §6.2 « duplication implicite interdite » quand l'utilisateur clique paste avec intent explicite (lecture architecte D1) ? Ou faut-il un prompt Yes/No (lecture `INSTRUCTIONS_TEST_REEL.md`) ?
3. **A3** — TTL d'orphelins : confirme-t-on **30 s** (manual-test-checklist) ou faut-il revenir à **5 s** (INSTRUCTIONS_TEST_REEL) ?
4. **A4** — `INSTRUCTIONS_TEST_REEL.md` est-il **obsolète** (remplacé par §7.x) ou **complémentaire** (dialogs/prompts/rename/drag-and-drop UI restent attendus en plus de §7.x) ?
5. **A5** — Acceptes-tu la dégradation L1 (mirroring best-effort `event.reason === Undo|Redo`) comme conforme à §3 « atomicité » ? L'API VS Code 1.95.0 ne permet pas mieux nativement.
6. **A6** — §1.4 « pas de dépendance curseur » s'applique-t-il à la **création** (geste UI) ou seulement au **tracking** (post-création) ?
7. **A7** — Faut-il ajouter §7.15 (édition externe), §7.16 (rename fichier), §7.17 (LSP F2 rename) ? Ou ces cas sont-ils hors scope Option C Phase 1 ?
8. **A8** — `outOfCodeInsights.suspendedTtlMs` doit-il être exposé en config utilisateur dans `package.json` ?
9. **A9** — Capacité par défaut du journal cyclique : **200** (brief Lot 1) ou **1024** (architecture) ?
10. **A10** — §7.14 exige-t-il la persistance disque du buffer suspendu (réimplémenter la persistance journal/buffer Phase 1) ou peut-on dégrader le test à `disposed` après reload (limit Phase 1 acceptée) ?
