# Setup — once per machine
1. Install: git (xcode-select --install), gh (brew install gh), Node (nodejs.org)
2. gh auth login   (GitHub.com → HTTPS → Yes → browser)
3. git config --global user.name "Your Name"; git config --global user.email "you@facilio.com"
4. gh repo clone asrohit723-jpg/Hue && cd Hue

## Branch workflow
git checkout -b fe/thing   # fe/* be/* eval/*
git add . && git commit -m "msg"
git pull --rebase origin main
git push -u origin fe/thing
main stays deployable; merge only at checkpoints; shared/contract.ts is frozen.

## Deploy (Rohit, at the end)
npm install -g @facilio/cli && facilio login && facilio whoami
git checkout main && git pull && facilio vibe deploy   # preview; then Publish in Facilio
