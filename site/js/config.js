// Edit this file to set up your group.
export const CONFIG = {
  // First names only. These become the "Who are you?" buttons.
  members: ["Anna", "Julie", "Piper", "Lilly", "Nicole"],
  defaultBudget: 1200,
  // Where the scraper's listings are, tried in order. Falls back to sample data if none load.
  dataUrls: ["listings.json", "../data/listings.json"],
  sampleUrl: "sample-listings.json",
  // Shared votes across everyone's phones. The publishable key is safe to be public:
  // it can only call the group-code-checked functions, never read the tables.
  supabase: {
    url: "https://blfcbaqvwceziilsubox.supabase.co",
    anonKey: "sb_publishable_5hkbWbg560Ac1beZzZYLYQ_3OaSi9NF",
  },
  // Phone alerts: the public half of the key pair, safe to be public. The private half is the
  // VAPID_PRIVATE_KEY GitHub secret; replacing one means replacing both (scraper/notify.py --new-keys).
  vapidPublicKey: "BLw_glGu4pYt4FsmoDBbaDiP5tsP9wdApO1FSfTsR96pnadFHlNplW-aXhFzmRO4b_qkpyMZGQo1kJYj-yJVcaM",
};
