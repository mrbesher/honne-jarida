export const TAXONOMY = {
  "Essentials": ["Groceries", "Household Supplies", "Rent/Mortgage", "Utilities", "Transportation", "Health & Medicine", "Communication"],
  "Eating Out": ["Restaurant", "Cafe", "Snacks"],
  "Lifestyle & Leisure": ["Clothing & Accessories", "Personal Care", "Entertainment", "Hobbies", "Subscriptions", "Gifts & Celebrations"],
  "Financial Obligations": ["Insurance", "Taxes"],
  "Household & Family": ["Furniture & Appliances"],
  "Study Expenses": ["Student Membership"],
  "Travel": ["Local Transportation", "Long-Distance", "Accommodation"],
  "Automobile-Related": ["Maintenance & Repairs"],
  "Work-Related Expenses": [],
  "Personal Development": [],
  "Technology & Gadgets": [],
  "Miscellaneous": ["Donations & Charity", "Miscellaneous"],
  "Other": [],
} as const;

export type Category = keyof typeof TAXONOMY;

export const isCategory = (s: string): s is Category => s in TAXONOMY;

export const isSubcategory = (cat: Category, sub: string): boolean =>
  (TAXONOMY[cat] as readonly string[]).includes(sub);
