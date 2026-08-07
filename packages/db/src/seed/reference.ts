/**
 * Reference data (spec §4.2).
 *
 * Region codes follow ISO 3166-2:IN so they match anything else the product
 * touches. Language codes are ISO 639-1 where one exists, ISO 639-2/3
 * otherwise (Konkani `kok`, Manipuri `mni`, Santali `sat`, Bodo `brx`,
 * Dogri `doi`, Maithili `mai`) — every language in the Eighth Schedule of the
 * Constitution, plus English.
 */

export const REGION_SEED = [
	{ code: "IN-AN", name: "Andaman and Nicobar Islands" },
	{ code: "IN-AP", name: "Andhra Pradesh" },
	{ code: "IN-AR", name: "Arunachal Pradesh" },
	{ code: "IN-AS", name: "Assam" },
	{ code: "IN-BR", name: "Bihar" },
	{ code: "IN-CH", name: "Chandigarh" },
	{ code: "IN-CT", name: "Chhattisgarh" },
	{ code: "IN-DH", name: "Dadra and Nagar Haveli and Daman and Diu" },
	{ code: "IN-DL", name: "Delhi" },
	{ code: "IN-GA", name: "Goa" },
	{ code: "IN-GJ", name: "Gujarat" },
	{ code: "IN-HP", name: "Himachal Pradesh" },
	{ code: "IN-HR", name: "Haryana" },
	{ code: "IN-JH", name: "Jharkhand" },
	{ code: "IN-JK", name: "Jammu and Kashmir" },
	{ code: "IN-KA", name: "Karnataka" },
	{ code: "IN-KL", name: "Kerala" },
	{ code: "IN-LA", name: "Ladakh" },
	{ code: "IN-LD", name: "Lakshadweep" },
	{ code: "IN-MH", name: "Maharashtra" },
	{ code: "IN-ML", name: "Meghalaya" },
	{ code: "IN-MN", name: "Manipur" },
	{ code: "IN-MP", name: "Madhya Pradesh" },
	{ code: "IN-MZ", name: "Mizoram" },
	{ code: "IN-NL", name: "Nagaland" },
	{ code: "IN-OR", name: "Odisha" },
	{ code: "IN-PB", name: "Punjab" },
	{ code: "IN-PY", name: "Puducherry" },
	{ code: "IN-RJ", name: "Rajasthan" },
	{ code: "IN-SK", name: "Sikkim" },
	{ code: "IN-TG", name: "Telangana" },
	{ code: "IN-TN", name: "Tamil Nadu" },
	{ code: "IN-TR", name: "Tripura" },
	{ code: "IN-UP", name: "Uttar Pradesh" },
	{ code: "IN-UT", name: "Uttarakhand" },
	{ code: "IN-WB", name: "West Bengal" },
] as const;

export const LANGUAGE_SEED = [
	{ code: "as", name: "Assamese", nativeName: "অসমীয়া" },
	{ code: "bn", name: "Bengali", nativeName: "বাংলা" },
	{ code: "brx", name: "Bodo", nativeName: "बड़ो" },
	{ code: "doi", name: "Dogri", nativeName: "डोगरी" },
	{ code: "en", name: "English", nativeName: "English" },
	{ code: "gu", name: "Gujarati", nativeName: "ગુજરાતી" },
	{ code: "hi", name: "Hindi", nativeName: "हिन्दी" },
	{ code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ" },
	{ code: "ks", name: "Kashmiri", nativeName: "کٲشُر" },
	{ code: "kok", name: "Konkani", nativeName: "कोंकणी" },
	{ code: "mai", name: "Maithili", nativeName: "मैथिली" },
	{ code: "ml", name: "Malayalam", nativeName: "മലയാളം" },
	{ code: "mni", name: "Manipuri", nativeName: "ꯃꯤꯇꯩ ꯂꯣꯟ" },
	{ code: "mr", name: "Marathi", nativeName: "मराठी" },
	{ code: "ne", name: "Nepali", nativeName: "नेपाली" },
	{ code: "or", name: "Odia", nativeName: "ଓଡ଼ିଆ" },
	{ code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ" },
	{ code: "sa", name: "Sanskrit", nativeName: "संस्कृतम्" },
	{ code: "sat", name: "Santali", nativeName: "ᱥᱟᱱᱛᱟᱲᱤ" },
	{ code: "sd", name: "Sindhi", nativeName: "سنڌي" },
	{ code: "ta", name: "Tamil", nativeName: "தமிழ்" },
	{ code: "te", name: "Telugu", nativeName: "తెలుగు" },
	{ code: "ur", name: "Urdu", nativeName: "اردو" },
] as const;
