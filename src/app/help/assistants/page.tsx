import Link from 'next/link'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

/**
 * Members-facing help for the MCP server: how to connect an assistant, what it can and cannot
 * see, and how to take it away again. Linked from Account → Identity → "Connect an AI assistant".
 * Public on purpose — nothing here is a secret, and people read it before they have an account.
 */

export const metadata = {
  title: 'Connect an AI assistant',
  description: 'Point Claude, ChatGPT or Cursor at the gatherings you belong to.',
}

const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://unconference.events').replace(/\/+$/, '')
const mcpUrl = `${appUrl}/api/mcp`

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="text-muted-foreground leading-relaxed space-y-3">{children}</div>
    </section>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] break-all">{children}</code>
}

export default function AssistantsHelpPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />

      <main className="container mx-auto px-5 py-12 max-w-3xl flex-1">
        <h1 className="page-title mb-2">Connect an AI assistant</h1>
        <p className="text-muted-foreground mb-8">
          Ask your own assistant about your gatherings — what is on tomorrow, who is hosting the thing about soil,
          what was actually said in a session you missed.
        </p>

        <div className="max-w-none space-y-8 text-sm">
          <Section title="How it works">
            <p>
              This site speaks <strong className="text-foreground">MCP</strong> (the Model Context Protocol), which is
              how assistants connect to outside tools. You mint a token, paste it into your assistant along with the
              server address, and the assistant can then look things up here while you talk to it.
            </p>
            <p>
              We do the looking up. Your assistant does the thinking. We never send your gathering&apos;s material to
              an AI model of our own for this — the excerpts go to whichever assistant you connected, and that
              company&apos;s terms apply to them from there.
            </p>
          </Section>

          <Section title="Get a token">
            <p>
              Open <Link href="/account?tab=identity" className="text-primary hover:underline">Account → Identity</Link>{' '}
              and find <strong className="text-foreground">Connect an AI assistant</strong>. Name the assistant
              (&ldquo;Claude on my laptop&rdquo;) and press Create token. The token starts with <Code>unc_</Code> and is
              shown <strong className="text-foreground">once</strong> — copy it before you close the box. We keep only a
              fingerprint of it, so we cannot show it to you again; if you lose it, revoke it and make another.
            </p>
            <p>
              You can hold up to five at a time — one per assistant, so you can take one away without disturbing the
              others.
            </p>
            <p>
              The server address is <Code>{mcpUrl}</Code>.
            </p>
          </Section>

          <Section title="Claude (claude.ai and Claude Desktop)">
            <p>
              In Claude, open <strong className="text-foreground">Settings → Connectors</strong> and choose{' '}
              <strong className="text-foreground">Add custom connector</strong>. Give it a name, paste{' '}
              <Code>{mcpUrl}</Code> as the URL, and put your token in the bearer-token / authorization field. Save,
              then enable the connector in a conversation. Ask it to list your gatherings to check it works.
            </p>
            <p>
              If your Claude Desktop version wants a config file instead, add a remote server with a proxy such as{' '}
              <Code>mcp-remote</Code>:
            </p>
            <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-4 text-xs leading-relaxed">
              <code>{`{
  "mcpServers": {
    "unconference": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${mcpUrl}",
        "--header", "Authorization: Bearer unc_YOUR_TOKEN"
      ]
    }
  }
}`}</code>
            </pre>
          </Section>

          <Section title="ChatGPT">
            <p>
              In ChatGPT, connectors are added from <strong className="text-foreground">Settings → Connectors →</strong>{' '}
              create a connector (on plans where custom MCP connectors are available; in the API it is a{' '}
              <Code>mcp</Code> tool on a response). Use <Code>{mcpUrl}</Code> as the server URL and your{' '}
              <Code>unc_…</Code> token as the authentication header. Choose &ldquo;no authentication provider /
              access token&rdquo; rather than OAuth: there is no sign-in dance here, just the token.
            </p>
          </Section>

          <Section title="Cursor">
            <p>
              Add the server to <Code>~/.cursor/mcp.json</Code> (or the project&apos;s <Code>.cursor/mcp.json</Code>):
            </p>
            <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-4 text-xs leading-relaxed">
              <code>{`{
  "mcpServers": {
    "unconference": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer unc_YOUR_TOKEN" }
    }
  }
}`}</code>
            </pre>
            <p>Restart Cursor and the tools appear under MCP in settings.</p>
          </Section>

          <Section title="What your assistant can see">
            <p>Exactly what you can see when you are signed in here, and nothing else:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>the gatherings you are a member of — not ones you have never joined, even public ones;</li>
              <li>their schedules and sessions, with hosts by the name and handle they chose;</li>
              <li>
                session transcripts you are allowed to read. If a gathering keeps transcripts to organizers, and you
                are not one, your assistant is refused them just as you are;
              </li>
              <li>search across those transcripts, when the server has a search provider configured;</li>
              <li>the corpus export, if you are an organizer of that gathering.</li>
            </ul>
          </Section>

          <Section title="What it can never see">
            <ul className="list-disc pl-5 space-y-1">
              <li>anything about a gathering you are not in;</li>
              <li>other people&apos;s email addresses, identifiers or private messages;</li>
              <li>votes — neither counts nor who voted, in an open round or a closed one;</li>
              <li>
                exact addresses. A session someone hosts at their own place is described by the coarse public place
                they chose; the exact spot, and any private group link, stay behind the session page;
              </li>
              <li>anything at all that changes: the connection is read-only. It cannot post, edit, RSVP or delete.</li>
            </ul>
            <p>
              A token is not a password. It cannot sign in as you, cannot reach your account settings, and cannot
              publish anything to your repository on the network.
            </p>
          </Section>

          <Section title="Take it away">
            <p>
              Go back to <Link href="/account?tab=identity" className="text-primary hover:underline">Account → Identity</Link>,
              find the assistant in the list, and press Revoke. It stops working immediately — no waiting, no
              propagation. The list also shows when each token was last used, so you can tell which ones are still
              doing anything.
            </p>
            <p>
              Do the same if you think a token leaked. Revoke it, then mint a fresh one and paste that into the
              assistant.
            </p>
          </Section>

          <Section title="If it does not connect">
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong className="text-foreground">401</strong> — the token is missing, mistyped or revoked. It must be
                sent as <Code>Authorization: Bearer unc_…</Code>.
              </li>
              <li>
                <strong className="text-foreground">429</strong> — more than 120 requests in a minute from one token.
                Wait a minute.
              </li>
              <li>
                <strong className="text-foreground">Search says it is not available</strong> — transcript search is
                switched off on this server, or the transcripts have not been indexed yet. That is an operator
                setting, not something you can fix; ask the organizers. Listing sessions and reading transcripts in
                full still work.
              </li>
            </ul>
          </Section>
        </div>
      </main>

      <Footer />
    </div>
  )
}
