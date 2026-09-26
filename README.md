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

**Bloqué après le choix de l'appareil** : le cas le plus probable est que
l'app Meshtastic est encore connectée au même T-Echo. Son service se
reconnecte tout seul en arrière-plan ; Android partage alors le lien Bluetooth
entre les deux applications et l'app officielle consomme les données que ce
lecteur attend. Au bout de 25 s le lecteur le dit et libère le lien. Remède :
dans l'app Meshtastic, se déconnecter de ce T-Echo, puis Paramètres Android →
Applications → Meshtastic → **Forcer l'arrêt**, et **Reconnecter**.

**« pas de canal secondaire nomme TXT »** : le T-Echo n'a pas le canal, ou pas
sous ce nom exact. Voir le README du dépôt principal.

## Développement

```
npm install
npm test          # format et logique, sans navigateur ni radio
npm run dev       # serveur local ; Web Bluetooth marche sur localhost
npm run build     # dans dist/
```

| Fichier | Rôle |
|---|---|
| `src/teletext.js` | format des pages, porté de `teletext.py` |
| `src/core.js` | toutes les décisions : filtrage, demandes, navigation |
| `src/radio.js` | lien Bluetooth, via `@meshtastic/core` ; seule partie non testable hors appareil |
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
