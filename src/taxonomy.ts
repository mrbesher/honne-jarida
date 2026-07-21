export const TAXONOMY = {
  "Essentials": ["Groceries", "Household Supplies", "Rent/Mortgage", "Utilities", "Communication", "Health & Medicine"],
  "Eating Out": ["Restaurant", "Cafe", "Snacks"],
  "Transportation": ["Public Transit", "Taxi & Rideshare", "Maintenance & Repairs", "Fuel", "Parking & Tolls", "Car Payments & Registration"],
  "Travel": ["Accommodation", "Long-Distance Transport", "Activities"],
  "Lifestyle & Leisure": ["Clothing & Accessories", "Personal Care", "Entertainment", "Hobbies", "Gifts & Celebrations"],
  "Subscriptions": ["Software & Apps", "Media & Memberships"],
  "Household & Family": ["Furniture & Appliances", "Home Maintenance & Repairs", "Childcare", "Pets"],
  "Education": ["Tuition & Fees", "Study Materials", "Courses & Books"],
  "Health & Fitness": ["Gym & Classes", "Sports Gear"],
  "Technology & Gadgets": ["Electronics", "Repairs"],
  "Financial": ["Insurance", "Taxes", "Debt Repayment", "Savings & Investments"],
  "Work": ["Office Supplies", "Business Meals", "Professional Services"],
  "Other": ["Donations & Charity", "Miscellaneous"],
} as const;

export type Category = keyof typeof TAXONOMY;

export const CATEGORIES = Object.keys(TAXONOMY) as Category[];

export const isCategory = (s: string): s is Category => s in TAXONOMY;

export const isSubcategory = (cat: Category, sub: string): boolean =>
  (TAXONOMY[cat] as readonly string[]).includes(sub);

export const canonicalCategory = (s: string): Category | null => {
  const lower = s.toLowerCase();
  return CATEGORIES.find(k => k.toLowerCase() === lower) ?? null;
};

export const canonicalSubcategory = (cat: Category, s: string): string | null => {
  const lower = s.toLowerCase();
  return (TAXONOMY[cat] as readonly string[]).find(sub => sub.toLowerCase() === lower) ?? null;
};
