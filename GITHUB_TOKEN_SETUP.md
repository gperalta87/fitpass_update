# GitHub Personal Access Token Setup

## Step 1: Create a Personal Access Token

1. Go to GitHub.com and sign in
2. Click your profile picture (top right) → **Settings**
3. Scroll down to **Developer settings** (left sidebar, at the bottom)
4. Click **Personal access tokens** → **Tokens (classic)**
5. Click **Generate new token** → **Generate new token (classic)**
6. Give it a name like "Fitpass Update Token"
7. Select expiration (e.g., "No expiration" or 90 days)
8. Check the **repo** scope (this gives full control of private repositories)
9. Click **Generate token**
10. **COPY THE TOKEN IMMEDIATELY** - you won't see it again!

## Step 2: Use the Token When Pushing

When you run `git push`, use the token as your password:

- **Username**: Your GitHub username (gperalta87)
- **Password**: Paste the Personal Access Token (not your GitHub password)

## Step 3: Optionally Save Credentials (macOS)

If you want to avoid entering the token each time:

```bash
git config --global credential.helper osxkeychain
```

Then when you push the first time, enter:
- Username: your GitHub username
- Password: the Personal Access Token

macOS will save it in your Keychain for future use.

## Alternative: Switch to SSH (More Secure)

If you prefer SSH:

1. Check if you have SSH keys:
   ```bash
   ls -la ~/.ssh
   ```

2. If no keys exist, generate one:
   ```bash
   ssh-keygen -t ed25519 -C "your_email@example.com"
   ```
   (Press Enter to accept defaults)

3. Add SSH key to GitHub:
   - Copy your public key: `cat ~/.ssh/id_ed25519.pub`
   - Go to GitHub → Settings → SSH and GPG keys
   - Click "New SSH key"
   - Paste the key and save

4. Change remote URL to SSH:
   ```bash
   git remote set-url origin git@github.com:gperalta87/fitpass_update.git
   ```

5. Then push normally:
   ```bash
   git push origin main
   ```

