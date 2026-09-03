import { createBrowserClient } from '@supabase/ssr'

const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()

if (!rawUrl) {
  throw new Error(
    'VESPER: NEXT_PUBLIC_SUPABASE_URL is missing. Check your .env.local file.'
  )
}

if (!publishableKey) {
  throw new Error(
    'VESPER: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing. Check your .env.local file.'
  )
}

// Supabase needs the project root URL.
// Remove accidental REST/API paths or trailing slashes.
const supabaseUrl = (() => {
  try {
    const url = new URL(rawUrl)

    // If someone accidentally pasted a REST endpoint such as
    // /rest/v1, strip it back to the project root.
    return `${url.protocol}//${url.host}`
  } catch {
    throw new Error(
      'VESPER: Invalid Supabase URL. It should look like https://your-project.supabase.co'
    )
  }
})()

export const supabase = createBrowserClient(
  supabaseUrl,
  publishableKey
)