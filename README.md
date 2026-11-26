# Cold Email Opener

Paste a company's website address and get a three-line cold email opener grounded in the site's text. The app uses a serverless API, Jina Reader for page text, and an optional OpenAI-compatible model. Without a model key, it drafts a deterministic fallback from extracted site details.

## Run locally

1. Install [Node.js](https://nodejs.org/) (version 18 or newer).
2. Open Terminal (Mac: press `Command + Space`, type `Terminal`, press Return).
3. Type `cd ` (include a space), then drag the **Cold Email Opener** folder from Finder into Terminal and press Return.
4. Run:

   ```bash
   npx vercel dev
   ```

5. If Terminal asks to install Vercel, type `y` and press Return. If it asks you to log in, follow the browser prompt and return to Terminal.
6. Open the local address printed in Terminal, usually `http://localhost:3000`.

The app works without a model key using its heuristic fallback. For model-written drafts, create a file named `.env.local` inside this folder with:

```env
LLM_API_KEY=your_provider_key
```

Never share or upload this key. `.gitignore` keeps `.env.local` out of GitHub.

## Put it on GitHub and deploy it (browser-only)

### 1. Create the GitHub repository

1. Sign in or create an account at [github.com](https://github.com/).
2. Open [github.com/new](https://github.com/new).
3. Name the repository `cold-email-opener`.
4. Choose **Public** so a recruiter can open the repository link.
5. Leave the options to add a README, `.gitignore`, or license unchecked. This project already contains its README and `.gitignore`.
6. Click **Create repository**.

### 2. Upload the project folder in your browser

1. On the new repository page, choose **Add file → Upload files**.
2. In Finder, locate the **Cold Email Opener** folder. Drag the folder onto GitHub’s upload area, or choose the files/folder when prompted. Keep the folder's contents at the repository root; you should see `api/`, `public/`, `README.md`, and `.gitignore` in the upload list.
3. If `.gitignore` is missing from the upload list, add it separately with **Add file → Create new file**, enter `.gitignore` as its name, and paste:

   ```text
   .env
   .env.local
   .vercel
   node_modules
   ```

4. Make sure you have not uploaded a file named `.env.local` or any API key.
5. In the commit message box, enter `Add cold email opener app`, select **Commit directly to the main branch**, and choose **Commit changes**.
6. You should now see `api`, `public`, `README.md`, and `.gitignore` on the repository page. Copy the browser address; that is the GitHub link to share.

GitHub supports uploading files or folders in the browser; see its [official upload instructions](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository).

### 3. Deploy the public app on Vercel

1. Open [vercel.com](https://vercel.com/) and sign in using **Continue with GitHub**.
2. Choose **Add New → Project**. If asked, install/authorize the Vercel GitHub app so Vercel can access this repository.
3. Find `cold-email-opener` and click **Import**. Keep the root directory as `./`, and keep the default framework/build settings.
4. To enable model-written drafts, add an environment variable before deploying: name `LLM_API_KEY`, value your model provider's API key. For OpenRouter the project uses its default OpenRouter endpoint/model. Never put the key in a GitHub file. You can skip this and use the app's heuristic fallback.
5. Click **Deploy**. Vercel connects the repository and automatically deploys future commits; see [Vercel's Git deployment guide](https://vercel.com/docs/git).
6. When deployment succeeds, click **Visit** and test a few public company websites. Check that the opener has three lines and that the first line matches the site. Try a site that blocks scraping too; the app should display an error rather than invent details.
7. Copy the Vercel URL to share the live app. Send both this URL and your GitHub repository URL to your recruiter.

If you add an environment variable after deployment, save it and redeploy from the Vercel **Deployments** page so the new deployment receives it. In GitHub's browser editor, changes can be made through **Add file → Create new file** or by opening a file and choosing the pencil icon; each commit to the connected branch triggers a new Vercel deployment.

## What runs where

- **Code:** validates the URL, fetches readable page text through Jina Reader, trims it to 4,000 characters, extracts page signals, checks the final three-line/55-word format, and uses a heuristic fallback if needed.
- **Model:** optionally phrases a draft from the scraped context and extracted signals. The server checks its output before returning it.

## Assignment response (150 words)

Code validates the URL, fetches the page through Jina Reader, trims its text to 4,000 characters, extracts visible headlines and prices, checks the draft’s format, and creates a fallback if the model fails. The model only phrases an opener from those details; code checks its response before display. At 1,000 runs, issues include scraping limits, model quotas, traffic bursts, delays, and abuse of the endpoint. Caching and rate limits would reduce work and misuse. A paid model may be needed if free quotas run out. Costs depend on provider prices and actual tokens. For example, at $0.36 per million input tokens and $0.40 per million output tokens, 1,300 input tokens plus 80 output tokens per run costs about $0.00050. At 30,000 runs, that is about $15, excluding hosting or scraping. Scraping and hosting have limits. The model never browses or verifies facts, so users should review each opener before sending.

*The 150-word response above is exactly 150 words, excluding its heading.*
