# Teletext Meshtastic — lecteur Android

Application web installable (PWA) qui lit le **teletext diffusé sur un canal
Meshtastic**, depuis un téléphone Android relié en Bluetooth à un T-Echo.

Le serveur qui produit les pages, le protocole et le client terminal sont
dans le dépôt principal, [Meshtastic-teletext](https://github.com/rezzonic/Meshtastic-teletext).
Ce dépôt-ci ne contient que le lecteur, et rien de privé : ni position, ni
clé de canal (la clé reste dans le T-Echo).

## Ce qu'il apporte par rapport à l'application Meshtastic

L'application Meshtastic affiche déjà les pages, puisque ce sont des messages
texte. Ce lecteur ajoute :

- la navigation par numéro de page, avec un pavé façon télécommande ;
- un cache qui survit à un cycle manqué et à la fermeture de l'application ;
- l'âge de chaque page, en rouge au-delà de 45 minutes ;
- pour les pages 311 et 312 (alarme générale, alarme-eau), un dessin du son
  de la sirène, généré ici à partir d'une ligne de signature : il ne passe pas
  par la radio (`src/sirens.js`, et `PROTOCOL.md` du dépôt principal) ;
- la demande d'une page au serveur (`?310`), limitée à une par page et par
  minute, espacées d'au moins 10 s : chaque demande coûte du temps d'antenne
  partagé. Feuilleter les pages en cache n'émet jamais rien.

## Installation

1. Ouvrir <https://rezzonic.github.io/meshtastic-teletext-web/> dans
   **Chrome sur Android**. Web Bluetooth n'existe ni dans Firefox, ni sur iOS.
2. Menu ⋮ → **Ajouter à l'écran d'accueil** (ou « Installer l'application »).
3. **Connecter**, choisir le T-Echo, saisir le code PIN affiché sur son écran.

Le T-Echo n'accepte qu'**une connexion Bluetooth à la fois** : pendant que ce
lecteur est connecté, l'application Meshtastic ne peut pas utiliser le même
appareil. Prévoir un T-Echo dédié à la lecture.

Le T-Echo doit porter un canal **secondaire** nommé `TXT`, avec la même clé
que le serveur (voir le README du dépôt principal, « Si rien n'arrive sur le
canal TXT »). Le lecteur refuse d'utiliser un canal `TXT` qui serait le
canal primaire : ce serait le maillage public.

Pour voir l'interface sans radio : ajouter `?demo` à l'adresse.

## Dépannage de la connexion

Sous le pavé, **Journal de connexion** note chaque étape avec l'heure : appareil
choisi, lien Bluetooth, configuration reçue, canaux vus (dont `TXT` et son
indice), pages reçues, erreurs. **Copier le journal** le met dans le
presse-papiers, avec la version du navigateur, pour le transmettre.

**Pas de code PIN demandé** : normal si le téléphone est déjà appairé à ce
T-Echo (par exemple pour l'app Meshtastic), ou si le T-Echo est en mode « PIN
fixe ».

**Longue attente après le choix de l'appareil** : à la connexion, un T-Echo
envoie d'ordinaire toute sa base de nœuds, une fiche par nœud connu, avant ses
canaux ; sur un maillage chargé, cela prend des dizaines de secondes en
Bluetooth. Le lecteur demande donc la configuration seule (nonce `69420` du
firmware) ; un firmware qui ne le connaît pas envoie tout quand même, et le
journal montre alors la progression (« 25 fiches de noeuds recues... »).

**Lecture périodique** : la bibliothèque Bluetooth ne lit le T-Echo qu'après
une écriture ou sur sa notification « fromNum ». Une lecture vide pendant que
le T-Echo prépare l'élément suivant, puis aucune notification, et plus rien
n'était lu : c'est ce qui arrêtait la configuration juste après « noeud
local ». Le lecteur lit donc aussi toutes les 150 ms pendant la configuration,
puis chaque seconde. Le journal compte les lectures, les lectures vides et les
notifications reçues.

**Une opération Bluetooth à la fois** : Chrome sur Android refuse une
opération GATT lancée pendant une autre (« GATT operation already in
progress »), et la bibliothèque ne les sérialise pas : la demande de
configuration pouvait partir pendant l'activation des notifications et
échouer (`Device connection lost`, puis lectures toutes vides). Le lecteur
ouvre donc le transport lui-même et fait passer toutes les lectures, écritures
et activations par un même verrou ; le journal indique combien ont dû attendre
leur tour, et nomme toute erreur GATT.

**Le journal interne de la bibliothèque plantait le décodage** : le logger
embarqué dans `@meshtastic/core` est la version Node de tslog ; pour chaque
avertissement il appelle `Buffer.isBuffer`, qui n'existe pas dans un
navigateur. Un firmware 2.7 envoie juste après l'identité une
`deviceuiConfig` que la bibliothèque ne gère pas et signale par un
avertissement : l'exception tuait le flux de décodage, et plus rien n'était
compris (« noeud local », puis des dizaines de lectures perdues). Le lecteur
rend `isBuffer` sûr, coupe masquage et mise en forme, et recopie les
avertissements de la bibliothèque dans le journal (« biblio: … ») avec le
décompte des éléments reçus par type.

**« le T-Echo n'envoie plus rien depuis 20 s »** : la connexion est libérée,
touchez **Reconnecter**. Si cela se répète, vérifiez que l'app Meshtastic
n'est pas connectée au même T-Echo (Paramètres Android → Applications →
Meshtastic → **Forcer l'arrêt**) : Android partage alors le lien Bluetooth
entre les deux applications.

**« pas de canal secondaire nomme TXT »** : le T-Echo n'a pas le canal, ou pas
sous ce nom exact. Voir le README du dépôt principal.

## Développement

```
npm install
npm test          # format et logique, sans navigateur ni radio
npm run dev       # serveur local ; Web Bluetooth marche sur localhost
npm run build     # dans dist/
```

`test/fake-techo.js` simule un T-Echo (firmware 2.7) derrière un faux serveur
GATT, aussi strict que Chrome sur Android. `npm test` le fait tourner sous
Node ; `test/browser/harness.html`, compilé avec la configuration de
l'application (`npx vite build --config test/browser/vite.config.js`, sortie
dans `dist-harness/`), le fait tourner dans un vrai navigateur, sans `Buffer`
ni rien de Node -- la différence qui a caché le défaut du logger.

| Fichier | Rôle |
|---|---|
| `src/teletext.js` | format des pages, porté de `teletext.py` |
| `src/core.js` | toutes les décisions : filtrage, demandes, navigation |
| `src/radio.js` | lien Bluetooth, via `@meshtastic/core` ; testé contre un T-Echo simulé (`test/radio.test.js`), jamais contre un vrai hors téléphone |
| `src/main.js` | écran, pavé, stockage du cache |
| `src/shims/` | remplaçants navigateur pour le logger Node embarqué dans `@meshtastic/core` |

Les demandes sont construites à la main (`radio.js`) parce que
`MeshDevice.sendText()` ne permet pas de fixer le `hop_limit` : à la valeur
par défaut de 3, chaque demande coûterait huit fois plus au maillage. D'où la
version **exacte** de `@bufbuild/protobuf`, identique à celle embarquée par
`@meshtastic/core`.

### Le format, en deux exemplaires

Le format est implémenté en Python dans le dépôt principal et en JavaScript
ici. `test/wire_vectors.json` est le contrat entre les deux : il est généré
par `testdata/make_wire_vectors.py` dans le dépôt principal, et
`npm test` vérifie que le JavaScript donne exactement les mêmes résultats.
**Si le format change là-bas, recopier ce fichier ici.**

## Publication

L'application est servie par GitHub Pages depuis la branche **`gh-pages`**,
qui ne contient que le résultat de `npm run build`. À régler une fois :
Settings → Pages → Source : **Deploy from a branch**, branche `gh-pages`,
dossier `/ (root)`. Pages est gratuit pour un dépôt public.

Pour republier après un changement :

```
npm test && npm run build
touch dist/.nojekyll
git -C dist init -q -b gh-pages && git -C dist add -A
git -C dist commit -qm "Publish" && git -C dist push -f <url du dépôt> gh-pages
rm -rf dist/.git
```

Pour que ce soit automatique à chaque push sur `main`, copier
`deploy/pages.yml` dans `.github/workflows/` (depuis l'interface GitHub :
*Add file*), puis choisir Source : **GitHub Actions**. Il teste, compile et
publie. Il n'est pas installé d'office parce que l'outil qui a créé ce dépôt
n'a pas le droit d'écrire les workflows.

## Licence

GPL-3.0, comme `@meshtastic/core` et `@meshtastic/transport-web-bluetooth`
qui sont intégrées au build.
