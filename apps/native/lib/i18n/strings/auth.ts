import { defineStrings } from "../define";

export default defineStrings({
	en: {
		tagline:
			"Sign in to share festival and daily greetings with your family and customers.",
		tabPhone: "Phone",
		tabEmail: "Email",
		or: "or",

		phoneLabel: "Mobile number",
		phoneHint: "Indian numbers need no +91. For other countries, start with +.",
		phoneInvalid: "Enter a 10-digit mobile number.",
		sendCode: "Send code by SMS",
		codeSentTo: "We sent a code to {phone}",
		codeLabel: "{length}-digit code",
		codeIncomplete: "Enter all {length} digits of the code.",
		verify: "Verify and sign in",
		changeNumber: "Change number",
		resend: "Send code again",
		resendIn: "Send again in {seconds}s",

		emailLabel: "Email",
		passwordLabel: "Password",
		confirmPasswordLabel: "Type the password again",
		enterEmail: "Enter your email address.",
		enterEmailFirst: "Enter your email address first.",
		passwordTooShort: "Use at least {length} characters.",
		passwordMismatch: "The two passwords do not match.",
		signIn: "Sign in",
		createAccount: "Create account",
		newAccount: "Create a new account",
		haveAccount: "I already have an account",
		forgotPassword: "Forgot password?",
		resetSent: "If that email has an account, a reset link is on its way.",
		verifySent:
			"We sent a link to {email}. Open it to confirm your email, then sign in.",
		verifyResent: "Sent again to {email}.",
		verifyHelp:
			"The link opens in your browser. After you open it, come back here.",
		verifyDone: "I have confirmed — sign me in",
		verifyResend: "Send link again",

		google: "Continue with Google",

		errInvalidPhone: "That does not look like a valid mobile number.",
		errTooMany: "Too many tries. Please wait a few minutes and try again.",
		errWrongCode: "That code is not right. Please check and try again.",
		errCodeExpired: "That code has expired. Ask for a new one.",
		errDeviceCheck:
			"This phone could not be verified. Try again, or use email instead.",
		errInvalidEmail: "That does not look like a valid email address.",
		errEmailInUse: "An account already exists for this email. Sign in instead.",
		errWeakPassword: "Use a longer password — at least eight characters.",
		errEnterPassword: "Enter your password.",
		errWrongCredentials: "That email or password is not right.",
		errDisabled: "This account has been turned off.",
		errMethodOff: "This way of signing in is not available right now.",
		errOtherMethod:
			"You already have an account with this email. Sign in the way you did before.",
		errEmailNotVerified:
			"Please confirm your email first — check your inbox for our link.",
		errGeneric: "Could not sign you in. Please try again.",
	},
	hi: {
		tagline:
			"त्योहार और रोज़ की शुभकामनाएँ अपने परिवार और ग्राहकों को भेजने के लिए साइन इन करें।",
		tabPhone: "फ़ोन",
		tabEmail: "ईमेल",
		or: "या",

		phoneLabel: "मोबाइल नंबर",
		phoneHint: "भारत के नंबर में +91 लिखने की ज़रूरत नहीं। दूसरे देश के लिए + से शुरू करें।",
		phoneInvalid: "10 अंकों का मोबाइल नंबर डालें।",
		sendCode: "SMS से कोड भेजें",
		codeSentTo: "हमने {phone} पर कोड भेजा है",
		codeLabel: "{length} अंकों का कोड",
		codeIncomplete: "कोड के सभी {length} अंक डालें।",
		verify: "कोड जाँचें और साइन इन करें",
		changeNumber: "नंबर बदलें",
		resend: "कोड फिर से भेजें",
		resendIn: "{seconds} सेकंड बाद फिर भेजें",

		emailLabel: "ईमेल",
		passwordLabel: "पासवर्ड",
		confirmPasswordLabel: "पासवर्ड फिर से लिखें",
		enterEmail: "अपना ईमेल पता डालें।",
		enterEmailFirst: "पहले अपना ईमेल पता डालें।",
		passwordTooShort: "कम से कम {length} अक्षर रखें।",
		passwordMismatch: "दोनों पासवर्ड एक जैसे नहीं हैं।",
		signIn: "साइन इन करें",
		createAccount: "खाता बनाएँ",
		newAccount: "नया खाता बनाएँ",
		haveAccount: "मेरा खाता पहले से है",
		forgotPassword: "पासवर्ड भूल गए?",
		resetSent: "अगर इस ईमेल का खाता है, तो पासवर्ड बदलने का लिंक भेज दिया गया है।",
		verifySent:
			"हमने {email} पर एक लिंक भेजा है। उसे खोलकर ईमेल पक्का करें, फिर साइन इन करें।",
		verifyResent: "{email} पर फिर से भेज दिया।",
		verifyHelp: "लिंक आपके ब्राउज़र में खुलेगा। खोलने के बाद यहाँ वापस आएँ।",
		verifyDone: "मैंने पक्का कर दिया — साइन इन करें",
		verifyResend: "लिंक फिर से भेजें",

		google: "Google से आगे बढ़ें",

		errInvalidPhone: "यह सही मोबाइल नंबर नहीं लगता।",
		errTooMany: "बहुत बार कोशिश हो गई। कुछ मिनट रुककर फिर कोशिश करें।",
		errWrongCode: "कोड सही नहीं है। जाँचकर फिर से डालें।",
		errCodeExpired: "यह कोड पुराना हो गया। नया कोड मँगाएँ।",
		errDeviceCheck:
			"इस फ़ोन की जाँच नहीं हो पाई। फिर कोशिश करें, या ईमेल से साइन इन करें।",
		errInvalidEmail: "यह सही ईमेल पता नहीं लगता।",
		errEmailInUse: "इस ईमेल का खाता पहले से है। साइन इन करें।",
		errWeakPassword: "लंबा पासवर्ड रखें — कम से कम आठ अक्षर।",
		errEnterPassword: "अपना पासवर्ड डालें।",
		errWrongCredentials: "ईमेल या पासवर्ड सही नहीं है।",
		errDisabled: "यह खाता बंद कर दिया गया है।",
		errMethodOff: "साइन इन का यह तरीका अभी उपलब्ध नहीं है।",
		errOtherMethod:
			"इस ईमेल से आपका खाता पहले से है। पहले जैसे साइन इन किया था, वैसे ही करें।",
		errEmailNotVerified:
			"पहले अपना ईमेल पक्का करें — हमारे लिंक के लिए अपना इनबॉक्स देखें।",
		errGeneric: "साइन इन नहीं हो पाया। कृपया फिर से कोशिश करें।",
	},
});
