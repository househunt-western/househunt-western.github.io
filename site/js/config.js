// Site settings. Groups and their members live in the database: people sign up and start or join one.
export const CONFIG = {
  defaultBudget: 1200,
  // Where the scraper's listings are, tried in order. Falls back to sample data if none load.
  dataUrls: ["listings.json", "../data/listings.json"],
  sampleUrl: "sample-listings.json",
  // Accounts and shared votes. The publishable key is safe to be public: it can only sign people
  // in and call the database functions, which check who's signed in. It never reads the tables.
  supabase: {
    url: "https://blfcbaqvwceziilsubox.supabase.co",
    anonKey: "sb_publishable_5hkbWbg560Ac1beZzZYLYQ_3OaSi9NF",
  },
  // Phone alerts: the public half of the key pair, safe to be public. The private half is the
  // VAPID_PRIVATE_KEY GitHub secret; replacing one means replacing both (scraper/notify.py --new-keys).
  vapidPublicKey: "BLw_glGu4pYt4FsmoDBbaDiP5tsP9wdApO1FSfTsR96pnadFHlNplW-aXhFzmRO4b_qkpyMZGQo1kJYj-yJVcaM",
};
