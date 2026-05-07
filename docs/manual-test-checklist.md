# Manual Test Checklist — F5 (Extension Development Host)

Validation manuelle des 14 cas §7.x de la spec après livraison complète Lot 5 R2 (consumer rewiring). Lance l'EDH avec **F5** depuis VS Code, ouvre un fichier `.ts` dans la fenêtre EDH, et exécute chaque scénario. Coche au fur et à mesure ; signale tout `[FAIL]` à l'orchestrateur.

## Préparation

- [ ] Build récent : `npm run package` exécuté sans erreur.
- [ ] Pas de fichier `annotations.json` résiduel d'une précédente session : exécuter la commande `Out-of-Code Insights: Clear all annotations` ou supprimer `<workspace>/.out-of-code-insights/annotations.json` avant chaque scénario.
- [ ] Panneau Annotations visible (icône activity bar).
- [ ] Tree view "Annotations" visible.

---

## §7.1 — Insertion AVANT la ligne ancrée

**Setup**

```ts
// 1
// 2
// 3
const TARGET = 1;  // ligne 4 (annotée)
const OTHER = 2;
```

**Steps**

1. [ ] Curseur sur ligne 4. Commande `Annotations: Add annotation`. Saisir `target-anno`. Confirmer.
2. [ ] Vérifier dans le tree : `target-anno` apparaît à `Line 4`.
3. [ ] Curseur ligne 0. Taper 3 lignes vides (`Enter` × 3 au début).
4. [ ] **Attendu** : `target-anno` est maintenant sur ligne 7. Le tree reflète `Line 7`.

**Pass**

- [ ] Annotation a suivi le code (offset shifted).
- [ ] Aucune annotation fantôme.

---

## §7.2 — Insertion SUR la ligne ancrée

**Setup**

```ts
const TARGET = 1;  // ligne 0 (annotée sur le segment "TARGET = 1")
```

**Steps**

1. [ ] Sélectionner `TARGET = 1` (sub-string), `Annotations: Add annotation`, message `partial-anno`.
2. [ ] Vérifier tree : `partial-anno` à `Line 0`.
3. [ ] Curseur ligne 0 colonne 0 (avant le `c` de `const`). Taper `// `.
4. [ ] **Attendu** : la ligne devient `// const TARGET = 1;`. L'annotation reste sur `Line 0`. Le hover/decoration couvre toujours `TARGET = 1`.

**Pass**

- [ ] Annotation reste sur la même ligne (line index inchangé).
- [ ] startOffset/endOffset shiftés du delta inséré (`3` chars).

---

## §7.3 — Suppression de la ligne ancrée

**Setup**

```ts
const PRESERVE_A = 0;
const TO_DELETE = 1;  // ligne 1 (annotée)
const PRESERVE_B = 2;
```

**Steps**

1. [ ] Annoter ligne 1 → `delete-target`.
2. [ ] Sélectionner ligne 1 entière (Shift+Down ou Home → Shift+End → Shift+Right pour inclure le \n) puis `Delete`.
3. [ ] **Attendu immédiat** : annotation disparaît du tree. Le panneau ne la liste plus.
4. [ ] Attendre 30 s (TTL par défaut) puis faire un autre edit (taper un espace ailleurs).
5. [ ] **Attendu après TTL** : annotation est `disposed`, **n'apparaît à AUCUNE autre position**.

**Pass**

- [ ] Pas de relocation automatique (interdit par spec).
- [ ] Pas d'annotation fantôme dans le tree.

---

## §7.4 — Cut sans paste

**Setup**

```ts
const PRE = 0;
const ANCHOR = 1;  // ligne 1 (annotée)
const POST = 2;
```

**Steps**

1. [ ] Annoter ligne 1 → `cut-orphan`.
2. [ ] `Ctrl+L` (sélectionner ligne) puis `Ctrl+X` (cut).
3. [ ] **Attendu immédiat** : annotation disparaît du tree (état `suspended` sous le capot).
4. [ ] Ne PAS coller. Attendre 30 s. Faire un autre edit.
5. [ ] **Attendu** : annotation reste absente du tree (TTL → disposed).

**Pass**

- [ ] L'annotation n'a pas été déplacée vers la ligne où le contenu a été coupé.
- [ ] Tree vide après TTL.

---

## §7.5 — Paste après cut

**Setup**

```ts
const PRE = 0;
const ANCHOR = 1;  // ligne 1 (annotée)
const POST = 2;
const TARGET_PASTE = 3;
```

**Steps**

1. [ ] Annoter ligne 1 → `cut-paste-victim`.
2. [ ] Cut ligne 1 (`Ctrl+L` + `Ctrl+X`).
3. [ ] Curseur ligne 3 (où il faut coller). `Ctrl+V`.
4. [ ] **Attendu** : `cut-paste-victim` réapparaît dans le tree à la nouvelle ligne. **MÊME ID** que avant le cut (vérifier dans `.out-of-code-insights/annotations.json` si nécessaire).

**Pass**

- [ ] Pas de duplication (toujours une seule annotation).
- [ ] ID préservé.
- [ ] Position correcte.

---

## §7.6 — Copy + paste : 2 annotations distinctes

**Setup**

```ts
const A = 0;
const SOURCE = 1;  // ligne 1 (annotée)
const B = 2;
const PASTE_HERE = 3;
```

**Steps**

1. [ ] Annoter ligne 1 → `original`.
2. [ ] `Ctrl+L` (sélectionner ligne) puis `Ctrl+C` (pas de cut).
3. [ ] Curseur ligne 3. `Ctrl+V`.
4. [ ] **Attendu** : 2 annotations dans le tree :
   - `original` toujours ligne 1
   - Nouvelle annotation au site collé (UUID **différent**, `origin.kind === 'paste'`, `message === 'original'`)

**Pass**

- [ ] Original intact, position inchangée.
- [ ] Clone créé avec nouvel ID.
- [ ] Métadonnées `origin.sourceOpId` pointent vers l'op d'add originale.

---

## §7.7 — Undo après paste

**Setup**

Reproduire §7.6 (copy + paste → 2 annotations).

**Steps**

1. [ ] `Ctrl+Z` (undo).
2. [ ] **Attendu** : l'annotation collée disparaît du tree. L'originale reste à ligne 1.

**Pass**

- [ ] Tree affiche 1 annotation (l'originale).
- [ ] Le clone n'est récupérable que via `Ctrl+Y` (redo).

---

## §7.8 — Redo restaure après undo

**Setup**

Reproduire §7.7 (after undo → 1 annotation).

**Steps**

1. [ ] `Ctrl+Y` (redo).
2. [ ] **Attendu** : le clone réapparaît avec **MÊME ID** qu'avant l'undo, **mêmes offsets**.

**Pass**

- [ ] Tree affiche 2 annotations.
- [ ] L'ID du clone est inchangé entre l'undo et le redo (vérifier JSON).

---

## §7.9 — Undo cut+paste rollback

**Setup**

```ts
const PRE = 0;
const ANCHOR = 1;  // annotée
const POST = 2;
const ELSEWHERE = 3;
```

**Steps**

1. [ ] Annoter ligne 1 → `roundtrip`.
2. [ ] Cut ligne 1, paste ligne 3.
3. [ ] **Pré-undo** : annotation à la nouvelle ligne (équivalent à §7.5).
4. [ ] `Ctrl+Z` (annule le paste). `Ctrl+Z` (annule le cut).
5. [ ] **Attendu** : annotation est de retour à la ligne 1 originale, **MÊME ID**.

**Pass**

- [ ] État identique au point de départ (offsets, ID, message).
- [ ] Pas de duplication.

---

## §7.10 — Multi-paste : N instances indépendantes

**Setup**

```ts
const SOURCE = 1;  // ligne 1 (annotée)
// lignes vides 2-10
```

**Steps**

1. [ ] Annoter ligne 1 → `multi-source`.
2. [ ] Copy (`Ctrl+L` + `Ctrl+C`).
3. [ ] Coller à 3 endroits différents (lignes 3, 6, 9). Trois `Ctrl+V` séparés.
4. [ ] **Attendu** : 4 annotations dans le tree :
   - `multi-source` original ligne 1
   - 3 clones, chacun avec UUID distinct et `origin.kind === 'paste'`.

**Pass**

- [ ] Total 4 entries.
- [ ] UUIDs deux à deux distincts.
- [ ] 3 clones marqués `origin.kind === 'paste'`.

---

## §7.11 — Sélection partielle (sub-line copy/cut)

**Setup**

```ts
const TARGET = 1;  // ligne 0 (annotée sur la ligne entière)
const ELSEWHERE;
```

**Steps**

1. [ ] Annoter ligne 0 (sélection ligne entière) → `full-line-anno`.
2. [ ] Sélectionner UN FRAGMENT de la ligne 0 (par exemple `= 1`). `Ctrl+C`.
3. [ ] Curseur ligne 1, fin. `Ctrl+V`.
4. [ ] **Attendu** : 1 SEULE annotation (`full-line-anno`). Le fragment collé n'a pas créé de clone (hash de la ligne complète ne matche pas le fragment).

**Pass**

- [ ] Pas de duplication incohérente.
- [ ] Annotation originale intacte.

---

## §7.12 — Suppression bloc multi-lignes

**Setup**

```ts
const A = 0;
const FIRST = 1;   // ligne 1 (annotée)
const SECOND = 2;  // ligne 2 (annotée)
const D = 3;
```

**Steps**

1. [ ] Annoter ligne 1 → `block-1`.
2. [ ] Annoter ligne 2 → `block-2`.
3. [ ] Sélectionner lignes 1-2 (Shift+Down × 2). `Delete`.
4. [ ] **Attendu immédiat** : les 2 annotations disparaissent du tree.

**Pass**

- [ ] Tree vide.
- [ ] Pas de fantôme à une autre ligne.

---

## §7.13 — Déplacement bloc cut+paste : IDs conservés

**Setup**

```ts
const A = 0;
const FIRST = 1;   // annotée
const SECOND = 2;  // annotée
const D = 3;
const E = 4;
const PASTE_HERE = 5;
```

**Steps**

1. [ ] Annoter ligne 1 → `block-1` (capturer son ID via JSON ou panneau).
2. [ ] Annoter ligne 2 → `block-2` (capturer ID).
3. [ ] Sélectionner lignes 1-2. `Ctrl+X`.
4. [ ] Curseur ligne 5. `Ctrl+V`.
5. [ ] **Attendu** : 2 annotations dans le tree, aux nouvelles lignes (lignes 5 et 6 post-shift). **MÊMES IDs** que avant le cut.

**Pass**

- [ ] IDs préservés.
- [ ] Position correcte (lignes 5 et 6 après le paste).
- [ ] Ordre préservé (block-1 avant block-2).

---

## §7.14 — Save / reload : état cohérent

**Setup**

Reproduire §7.6 (1 annotation active + 1 clone) + cut une 3ème annotation pour la mettre en `suspended` (sans paste).

**Steps**

1. [ ] Annoter ligne 0 → `active-1`.
2. [ ] Annoter ligne 5 → `to-cut`.
3. [ ] Cut ligne 5 (annotation `to-cut` passe en suspended).
4. [ ] Annoter ligne 8 → `active-2` puis `Annotations: Edit annotation` pour modifier le message en `active-2-edited`.
5. [ ] `Ctrl+S` pour sauvegarder.
6. [ ] Fermer la fenêtre EDH (`Ctrl+W` puis fermer la fenêtre).
7. [ ] Relancer F5 et rouvrir le même fichier.
8. [ ] **Attendu** :
   - Tree affiche `active-1` et `active-2-edited` (2 actives).
   - `to-cut` reste suspended (visible dans `.out-of-code-insights/annotations.json` avec `state: 'suspended'`, mais pas dans le tree).
   - Coller le contenu de `to-cut` ailleurs → l'annotation ré-apparaît avec son ID original (paste-resume).

**Pass**

- [ ] Aucune annotation fantôme à des positions imprévues.
- [ ] IDs préservés à travers le save/reload.
- [ ] Le message le plus récent (`active-2-edited`) est celui restauré.
- [ ] `schemaVersion: 2` présent dans le JSON persisté.

---

## Vérifications globales post-checklist

- [ ] Aucune entrée du panneau Annotations n'a un `[?]` ou un état "ambigu" non résolu.
- [ ] Aucune erreur dans l'output channel `Out-of-Code Insights`.
- [ ] `Annotations: Clear all annotations` fonctionne et vide le tree + le JSON.
- [ ] Reload de la fenêtre VS Code (`Developer: Reload Window`) ne crée pas de duplications ni de fantômes.

## Si un test échoue

1. Capturer le contenu de `.out-of-code-insights/annotations.json` AVANT et APRÈS l'opération qui a foiré.
2. Capturer la sortie de l'output channel `Out-of-Code Insights` pendant l'opération.
3. Reporter à l'orchestrateur avec le numéro du §7.x, l'étape exacte, et les artefacts ci-dessus.
