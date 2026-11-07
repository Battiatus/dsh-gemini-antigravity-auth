<h1 align="center">dsh-gemini-antigravity-auth</h1>

<p align="center"><strong>Gemini dans DeepSeek Harness, avec votre abonnement Google Antigravity.</strong><br>
Connectez-vous avec Google, choisissez un modèle Gemini, et votre agent cherche sur le web et comprend images, audio, vidéo et PDF.</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#fonctionnalités">Fonctionnalités</a> ·
  <a href="#utilisation">Utilisation</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="README.md">English</a>
</p>

---

**dsh-gemini-antigravity-auth** est un plugin [DeepSeek Harness](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (DSH) qui ajoute les modèles Google **Gemini** via l'OAuth **Google Antigravity**. Pas de clé API, pas d'outil en plus : vous vous connectez avec votre compte Google et les modèles Gemini apparaissent dans le sélecteur de modèles de DSH, à côté de vos autres fournisseurs.

## Fonctionnalités

- 🔐 **Connexion Google (OAuth)** : un clic dans les réglages ou `/agy login`. Aucune clé API à copier.
- 🤖 **Vos modèles Antigravity, tels que Google les liste** : le sélecteur affiche exactement les modèles que Google propose à votre compte (Gemini, et Claude ou GPT-OSS si votre forfait les inclut), avec les noms de Google, lus sur votre compte à la connexion.
- 🧠 **Niveaux de raisonnement** : une entrée par famille de modèles (Gemini 3.8 Flash, Gemini 4 Argon, Claude…) avec Low / Medium / High dans le sélecteur de raisonnement de DSH. Le niveau arrive vraiment chez Google (budget de réflexion), et le raisonnement du modèle s'affiche dans la conversation.
- 👥 **Plusieurs comptes Google** : ajouter, changer, retirer, et voir pour chacun les limites de 5 h et de la semaine par groupe de modèles (Gemini, Claude et GPT, Argon), comme dans Antigravity.
- 🎨 **Outil `agy_image`** : l'agent crée des images, ou retouche jusqu'à 5 images du dossier de travail, avec le modèle d'image que Google propose à votre compte (Nano Banana).
- 🔁 **Appels robustes** : un jeton refusé est rafraîchi et la requête rejouée, un serveur saturé est réessayé, et un quota épuisé indique quand il se recharge.
- 🖼️ **Pièces jointes multimodales** : images, audio, vidéo et PDF joints au message partent tels quels vers Gemini.
- 🔎 **Outil `agy_web_search`** : recherche Google avec sources, utilisable par tous les agents.
- 🎬 **Outil `agy_media`** : l'agent analyse un fichier image, audio, vidéo ou PDF du dossier de travail (~36 Mo max).
- 🎛️ **Interrupteurs d'accès** : activer ou couper les modèles Gemini, la recherche web ou l'analyse de médias, et masquer les modèles inutiles.
- 🧩 **Compatible avec les outils DSH** : appels d'outils complets, schémas adaptés à ce que Gemini accepte.

## Installation

Fermez DeepSeek Harness, puis lancez :

```bash
dsh plugin --profile desktop add gemini-dsh
```

Relancez DeepSeek Harness. C'est tout.

Vous installez depuis l'écran des plugins de l'application ? Collez l'adresse complète :

```text
git+https://github.com/Battiatus/dsh-gemini-antigravity-auth.git
```

> **`dsh: command not found` ?** La commande est fournie avec l'application, dans son dossier `runtime/cli/bin` :
> - macOS : `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"`
> - Windows et Linux : `resources/runtime/cli/bin/` dans le dossier d'installation de DeepSeek Harness.
> Changez `--profile` (par exemple `web` ou `tui`) pour l'installer dans un autre profil DSH.

**Mettre à jour**

```bash
dsh plugin --profile desktop update gemini-dsh
```

**Désinstaller**

```bash
dsh plugin --profile desktop remove gemini-dsh
```

## Utilisation

1. Ouvrez **Réglages › Antigravity** et cliquez sur **Sign in with Google** (l'interface est en anglais), ou tapez `/agy login`.
2. Choisissez votre compte Google et autorisez l'accès dans la page qui s'ouvre. Si rien ne s'ouvre, cliquez sur **Open Google sign-in**.
3. Choisissez un modèle **Antigravity** dans le sélecteur et discutez.

**DSH utilisé depuis un autre appareil** (DSH web sur un serveur, un téléphone, un autre PC) : après validation, Google envoie votre navigateur sur une page `localhost:51121` qui ne charge pas. Copiez l'adresse complète de cette page et collez-la dans le champ sous **Open Google sign-in**, ou lancez `/agy login <adresse>`.

### Commande `/agy`

| Commande | Effet |
| --- | --- |
| `/agy login` | Ajouter un compte Google : affiche le lien de connexion |
| `/agy login <adresse>` | Terminer une connexion faite depuis un autre appareil, avec l'adresse où Google vous a renvoyé |
| `/agy status` | Lister les comptes, l'actif est marqué ● |
| `/agy use <email>` | Changer de compte actif |
| `/agy logout [email]` | Retirer un compte (l'actif par défaut) |

### Outils de l'agent

| Outil | Effet |
| --- | --- |
| `agy_web_search` | Cherche sur Google et répond avec ses sources |
| `agy_media` | Décrit, transcrit ou analyse un fichier image, audio, vidéo ou PDF du dossier de travail |
| `agy_image` | Crée une image à partir d'une description, ou retouche des images du dossier de travail |

## FAQ

**C'est officiel ?**
Non. Le plugin utilise la même connexion que Google Antigravity. Google a déjà suspendu des comptes branchés ainsi dans des outils tiers : à vos risques.

**Où sont mes jetons ?**
Uniquement sur votre machine, dans `~/.dsh/agy-multimodal/accounts.json` (droits `0600`), jamais affichés. Les réglages d'accès sont dans `settings.json` à côté.

**Rien ne se passe après la validation chez Google.**
La connexion écoute sur `127.0.0.1:51121`, le port imposé par Google pour ce client, sur la machine qui fait tourner DSH. Si votre navigateur est sur un autre appareil, ou si un autre outil Antigravity occupe ce port, copiez l'adresse de la page où Google vous a renvoyé et collez-la dans **Réglages › Antigravity** (ou lancez `/agy login <adresse>`).

**Les réglages affichent « fetch failed », une erreur de certificat ou aucun modèle (souvent sous Windows ou au bureau).**
Si une ligne du fichier `hosts` ou un bloqueur DNS installé par un autre outil envoie `cloudcode-pa.googleapis.com` sur `127.0.0.1`, le plugin demande la vraie adresse de Google à vos serveurs DNS, pour ces seuls noms Antigravity : vous n'avez rien à modifier. Le plugin fait aussi confiance aux certificats de votre système (magasin Windows, trousseau macOS, certificats Linux) : un antivirus ou un proxy d'entreprise qui inspecte HTTPS est accepté comme dans votre navigateur. L'erreur nomme désormais la vraie cause : pour le DNS ou une connexion bloquée, vérifiez VPN et pare-feu ; derrière un proxy, définissez `HTTPS_PROXY` (par exemple `http://proxy.entreprise:8080`) avant de lancer DeepSeek Harness.

**J'ai une erreur 400 sur les schémas d'outils.**
Mettez le plugin à jour : les versions récentes convertissent les schémas multi-types et en tuple dans une forme que Gemini accepte.

## Développement

```bash
git clone https://github.com/Battiatus/dsh-gemini-antigravity-auth.git
cd dsh-gemini-antigravity-auth && npm install && npm test
dsh plugin --profile desktop add link:$PWD
```

Avec `link:`, DSH charge le plugin depuis votre clone : une modification du code s'applique au prochain lancement de DSH.

Aucune dépendance : le plugin n'utilise que Node.js, rien de tiers ne peut le casser ou le compromettre.

## Licence

[MIT](LICENSE)
