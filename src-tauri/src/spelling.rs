//! Spelling, from the macOS spell checker (NSSpellChecker). It follows the languages set in System
//! Settings, and knows the words you taught it in any Mac app.

use serde::Serialize;

/// One text's misspelled words, and the language it was checked in.
#[derive(Serialize, Debug, PartialEq)]
pub struct Checked {
    /// Such as "en" or "es". None when the checker couldn't tell.
    pub language: Option<String>,
    /// Offsets in UTF-16 code units, as JavaScript counts them, in order.
    pub words: Vec<(usize, usize)>,
}

/// Checks each text. `sample` is some of the page, for the language of a text too short to tell.
#[tauri::command]
pub async fn check_spelling(texts: Vec<String>, sample: String) -> Vec<Checked> {
    let mut page: Option<Option<String>> = None;
    texts
        .iter()
        .map(|text| {
            check(text, || {
                page.get_or_insert_with(|| language_of(&sample)).clone()
            })
        })
        .collect()
}

/// What the checker would put in place of a word, best first.
#[tauri::command]
pub async fn spelling_guesses(word: String, language: Option<String>) -> Vec<String> {
    guesses(&word, language.as_deref())
}

/// Adds a word to the Mac's own word list, shared with every app.
#[tauri::command]
pub fn learn_spelling(word: String) {
    learn(&word);
}

/// Whether the word is in the Mac's own word list. "teh" learned covers "Teh".
#[tauri::command]
pub fn learned_spelling(word: String) -> bool {
    has_learned(&word)
}

/// Takes a word out of the Mac's own word list. "Teh" takes out "teh".
#[tauri::command]
pub fn unlearn_spelling(word: String) {
    unlearn(&word);
}

// AppKit's text checking may run off the main thread, so a long page never blocks the window.
#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSOrthography, NSRange, NSString, NSTextCheckingType};

    /// What the checker says when it can't tell the language.
    const UNDETERMINED: &str = "und";

    fn checker() -> Retained<NSSpellChecker> {
        NSSpellChecker::sharedSpellChecker()
    }

    /// The misspelled words, and the language the checker found for the text.
    fn check_detecting(
        string: &NSString,
        types: NSTextCheckingType,
    ) -> (Vec<(usize, usize)>, Option<String>) {
        let mut orthography: Option<Retained<NSOrthography>> = None;
        // SAFETY: no options, and a null word count, which the checker allows.
        let results = unsafe {
            checker().checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(
                string,
                NSRange::new(0, string.length()),
                types.0,
                None,
                0,
                Some(&mut orthography),
                std::ptr::null_mut(),
            )
        };
        let words = results
            .iter()
            .filter(|r| r.resultType() == NSTextCheckingType::Spelling)
            .map(|r| (r.range().location, r.range().location + r.range().length))
            .collect();
        let language = orthography
            .map(|o| o.dominantLanguage().to_string())
            .filter(|l| l != UNDETERMINED);
        (words, language)
    }

    /// The misspelled words in one language.
    fn check_in(string: &NSString, language: &str) -> Vec<(usize, usize)> {
        let language = NSString::from_str(language);
        let mut words = Vec::new();
        let mut at = 0;
        while at < string.length() {
            // SAFETY: a null word count, which the checker allows.
            let found = unsafe {
                checker().checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
                    string,
                    at as isize,
                    Some(&language),
                    false,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if found.location == objc2_foundation::NSNotFound as usize || found.length == 0 {
                break;
            }
            words.push((found.location, found.location + found.length));
            at = found.location + found.length;
        }
        words
    }

    pub fn check(text: &str, page_language: impl FnOnce() -> Option<String>) -> super::Checked {
        autoreleasepool(|_| {
            let string = NSString::from_str(text);
            let (words, language) = check_detecting(
                &string,
                NSTextCheckingType::Spelling | NSTextCheckingType::Orthography,
            );
            if language.is_some() {
                return super::Checked { language, words };
            }
            // Too short to tell, so the checker takes a word from any language you write in: "We
            // teh" passes, as "teh" is Indonesian. Use the page's language instead.
            match page_language() {
                Some(page) => super::Checked {
                    words: check_in(&string, &page),
                    language: Some(page),
                },
                None => super::Checked {
                    language: None,
                    words,
                },
            }
        })
    }

    pub fn language_of(sample: &str) -> Option<String> {
        autoreleasepool(|_| {
            check_detecting(&NSString::from_str(sample), NSTextCheckingType::Orthography).1
        })
    }

    pub fn guesses(word: &str, language: Option<&str>) -> Vec<String> {
        autoreleasepool(|_| {
            let string = NSString::from_str(word);
            let language = language.map(NSString::from_str);
            checker()
                .guessesForWordRange_inString_language_inSpellDocumentWithTag(
                    NSRange::new(0, string.length()),
                    &string,
                    language.as_deref(),
                    0,
                )
                .map(|list| list.iter().map(|g| g.to_string()).collect())
                .unwrap_or_default()
        })
    }

    pub fn learn(word: &str) {
        checker().learnWord(&NSString::from_str(word));
    }

    pub fn has_learned(word: &str) -> bool {
        checker().hasLearnedWord(&NSString::from_str(word))
    }

    pub fn unlearn(word: &str) {
        checker().unlearnWord(&NSString::from_str(word));
    }
}

#[cfg(target_os = "macos")]
use mac::{check, guesses, has_learned, language_of, learn, unlearn};

/// The words in a text, as UTF-16 offsets: letters and digits, with an apostrophe inside a word
/// kept ("don't", "rock ’n’ roll" gives "n"). Hyphens and other marks split words. A word with a
/// digit or an underscore ("3rd", "snake_case") is skipped, as spell checkers do.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn words(text: &str) -> Vec<(usize, usize, String)> {
    let chars: Vec<char> = text.chars().collect();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let is_apostrophe = |c: char| c == '\'' || c == '’';
    let mut found = Vec::new();
    let mut at = 0; // UTF-16 offset of chars[i]
    let mut i = 0;
    while i < chars.len() {
        if !is_word(chars[i]) {
            at += chars[i].len_utf16();
            i += 1;
            continue;
        }
        let (start, start_at) = (i, at);
        while i < chars.len()
            && (is_word(chars[i])
                || (is_apostrophe(chars[i]) && chars.get(i + 1).is_some_and(|&c| is_word(c))))
        {
            at += chars[i].len_utf16();
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        if !word.chars().any(|c| c.is_numeric() || c == '_') {
            found.push((start_at, at, word));
        }
    }
    found
}

/// Spelling from Enchant, which uses Hunspell's dictionaries. It checks in the language of `LANG`
/// (install `hunspell-en_us` or another `hunspell-*` package), and learned words go to Enchant's
/// personal word list, `~/.config/enchant/<language>.dic`, shared with other apps that use it.
#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::{c_char, c_int, CStr, CString};
    use std::sync::{Mutex, OnceLock};

    #[repr(C)]
    struct EnchantBroker {
        _private: [u8; 0],
    }
    #[repr(C)]
    struct EnchantDict {
        _private: [u8; 0],
    }

    #[link(name = "enchant-2")]
    extern "C" {
        fn enchant_broker_init() -> *mut EnchantBroker;
        fn enchant_broker_request_dict(broker: *mut EnchantBroker, tag: *const c_char) -> *mut EnchantDict;
        fn enchant_dict_check(dict: *mut EnchantDict, word: *const c_char, len: isize) -> c_int;
        fn enchant_dict_suggest(
            dict: *mut EnchantDict,
            word: *const c_char,
            len: isize,
            out_n: *mut usize,
        ) -> *mut *mut c_char;
        fn enchant_dict_free_string_list(dict: *mut EnchantDict, list: *mut *mut c_char);
        fn enchant_dict_add(dict: *mut EnchantDict, word: *const c_char, len: isize);
        fn enchant_dict_remove(dict: *mut EnchantDict, word: *const c_char, len: isize);
        fn enchant_dict_is_added(dict: *mut EnchantDict, word: *const c_char, len: isize) -> c_int;
    }

    /// One dictionary for the app's life. Enchant isn't thread safe, so it sits behind a lock.
    struct Dict {
        dict: *mut EnchantDict,
        language: String,
    }
    // SAFETY: the pointer is only used while holding the Mutex below.
    unsafe impl Send for Dict {}

    /// "en_US" from LANG=en_US.UTF-8, else en_US.
    fn language_tag() -> String {
        std::env::var("LANG")
            .ok()
            .map(|l| l.split(['.', '@']).next().unwrap_or("").to_string())
            .filter(|l| !l.is_empty() && l != "C" && l != "POSIX")
            .unwrap_or_else(|| "en_US".into())
    }

    fn dict() -> &'static Mutex<Option<Dict>> {
        static DICT: OnceLock<Mutex<Option<Dict>>> = OnceLock::new();
        DICT.get_or_init(|| {
            // SAFETY: the broker lives for the app's life, so it is never freed.
            let broker = unsafe { enchant_broker_init() };
            if broker.is_null() {
                return Mutex::new(None);
            }
            let tag = language_tag();
            // "en_US", then "en".
            let tags = [tag.clone(), tag.split('_').next().unwrap_or(&tag).to_string()];
            let found = tags.iter().find_map(|t| {
                let c = CString::new(t.as_str()).ok()?;
                // SAFETY: broker is non-null and the tag is a valid C string.
                let d = unsafe { enchant_broker_request_dict(broker, c.as_ptr()) };
                (!d.is_null()).then(|| Dict { dict: d, language: t.clone() })
            });
            if found.is_none() {
                eprintln!("Undertext: no spelling dictionary for {tag}. Install hunspell-en_us or another hunspell-* package.");
            }
            Mutex::new(found)
        })
    }

    /// Runs `f` with the dictionary, or returns `default` when there is none.
    fn with<T>(default: T, f: impl FnOnce(&Dict) -> T) -> T {
        match dict().lock() {
            Ok(guard) => guard.as_ref().map_or(default, f),
            Err(_) => default,
        }
    }

    /// Hunspell's dictionaries spell "don't" with a straight apostrophe.
    fn plain(word: &str) -> Option<CString> {
        CString::new(word.replace('’', "'")).ok()
    }

    fn is_correct(d: &Dict, word: &str) -> bool {
        let Some(c) = plain(word) else { return true };
        // SAFETY: d.dict is non-null; -1 means the string is NUL-terminated.
        unsafe { enchant_dict_check(d.dict, c.as_ptr(), -1) == 0 }
    }

    pub fn check(text: &str, _page_language: impl FnOnce() -> Option<String>) -> super::Checked {
        with(super::Checked { language: None, words: Vec::new() }, |d| super::Checked {
            language: Some(d.language.clone()),
            words: super::words(text)
                .into_iter()
                .filter(|(_, _, w)| !is_correct(d, w))
                .map(|(from, to, _)| (from, to))
                .collect(),
        })
    }

    pub fn language_of(_sample: &str) -> Option<String> {
        with(None, |d| Some(d.language.clone()))
    }

    pub fn guesses(word: &str, _language: Option<&str>) -> Vec<String> {
        with(Vec::new(), |d| {
            let Some(c) = plain(word) else { return Vec::new() };
            let mut n = 0usize;
            // SAFETY: d.dict is non-null; the list is freed with the call Enchant provides.
            unsafe {
                let list = enchant_dict_suggest(d.dict, c.as_ptr(), -1, &mut n);
                if list.is_null() {
                    return Vec::new();
                }
                let out = (0..n)
                    .map(|i| CStr::from_ptr(*list.add(i)).to_string_lossy().into_owned())
                    .collect();
                enchant_dict_free_string_list(d.dict, list);
                out
            }
        })
    }

    pub fn learn(word: &str) {
        with((), |d| {
            if let Some(c) = plain(word) {
                // SAFETY: d.dict is non-null.
                unsafe { enchant_dict_add(d.dict, c.as_ptr(), -1) }
            }
        })
    }

    /// As on the Mac, "teh" learned covers "Teh".
    pub fn has_learned(word: &str) -> bool {
        with(false, |d| {
            [word.to_string(), word.to_lowercase()].iter().any(|w| {
                // SAFETY: d.dict is non-null.
                plain(w).is_some_and(|c| unsafe { enchant_dict_is_added(d.dict, c.as_ptr(), -1) } != 0)
            })
        })
    }

    /// "Teh" takes out "teh". Enchant also lists a removed word as wrong, which is right for a
    /// word you taught it, the only kind the page offers to unlearn.
    pub fn unlearn(word: &str) {
        with((), |d| {
            for w in [word.to_string(), word.to_lowercase()] {
                // SAFETY: d.dict is non-null.
                let added = plain(&w).is_some_and(|c| unsafe { enchant_dict_is_added(d.dict, c.as_ptr(), -1) } != 0);
                if let (true, Some(c)) = (added, plain(&w)) {
                    unsafe { enchant_dict_remove(d.dict, c.as_ptr(), -1) }
                }
            }
        })
    }
}

#[cfg(target_os = "linux")]
use linux::{check, guesses, has_learned, language_of, learn, unlearn};

// Elsewhere, nothing is marked.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn check(_text: &str, _page_language: impl FnOnce() -> Option<String>) -> Checked {
    Checked {
        language: None,
        words: Vec::new(),
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn language_of(_sample: &str) -> Option<String> {
    None
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn guesses(_word: &str, _language: Option<&str>) -> Vec<String> {
    Vec::new()
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn learn(_word: &str) {}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn has_learned(_word: &str) -> bool {
    false
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn unlearn(_word: &str) {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::NSString;

    const ENGLISH: &str = "We wrote a plan for the next week, and it went well. The team liked it.";
    const SPANISH: &str =
        "Escribimos un plan para la semana que viene, y salió bien. Al equipo le gustó.";

    fn run(texts: &[&str], sample: &str) -> Vec<Checked> {
        let texts = texts.iter().map(|t| t.to_string()).collect();
        tauri::async_runtime::block_on(check_spelling(texts, sample.to_string()))
    }

    fn words(text: &str) -> Vec<(usize, usize)> {
        run(&[text], ENGLISH).remove(0).words
    }

    #[test]
    fn finds_misspelled_words() {
        assert_eq!(
            run(&["Teh cat sat on teh mat, and we recieve it."], ""),
            vec![Checked {
                language: Some("en".into()),
                words: vec![(0, 3), (15, 18), (31, 38)]
            }]
        );
    }

    #[test]
    fn correct_text_has_none() {
        assert_eq!(
            words("The quick brown fox jumps over the lazy dog."),
            vec![]
        );
        assert_eq!(words(""), vec![]);
    }

    #[test]
    fn counts_offsets_as_javascript_does() {
        // The emoji is two UTF-16 units, é is one: "recieve" starts at 8, not at 11 bytes in.
        assert_eq!(words("😀 Café recieve"), vec![(8, 15)]);
    }

    #[test]
    fn checks_each_text_on_its_own() {
        let found: Vec<_> = run(&["Fine words.", "A wrod here."], ENGLISH)
            .into_iter()
            .map(|c| c.words)
            .collect();
        assert_eq!(found, vec![vec![], vec![(2, 6)]]);
    }

    #[test]
    fn checks_each_text_in_its_own_language() {
        assert_eq!(
            run(
                &[
                    "El perro es muy bonnito y la casa es grande.",
                    "We recieve it, and the dog is big."
                ],
                ENGLISH
            ),
            vec![
                Checked {
                    language: Some("es".into()),
                    words: vec![(16, 23)]
                },
                Checked {
                    language: Some("en".into()),
                    words: vec![(3, 10)]
                },
            ]
        );
    }

    #[test]
    fn a_text_too_short_to_tell_takes_the_page_language() {
        assert_eq!(
            run(&["We teh", "Teh plan"], ENGLISH),
            vec![
                Checked {
                    language: Some("en".into()),
                    words: vec![(3, 6)]
                },
                Checked {
                    language: Some("en".into()),
                    words: vec![(0, 3)]
                },
            ]
        );
        // "Gracias" is Spanish, so it passes on a Spanish page.
        assert_eq!(
            run(&["Gracias amgio"], SPANISH),
            vec![Checked {
                language: Some("es".into()),
                words: vec![(8, 13)]
            }]
        );
    }

    #[test]
    fn guesses_follow_the_language() {
        let guess = |word: &str, language: &str| {
            tauri::async_runtime::block_on(spelling_guesses(word.into(), Some(language.into())))
        };
        assert_eq!(
            guess("recieve", "en").first().map(String::as_str),
            Some("receive")
        );
        assert!(guess("teh", "en").contains(&"the".to_string()));
        assert!(guess("amgio", "es").contains(&"amigo".to_string()));
    }

    /// Forgets a test's word even if an assertion fails, so the Mac's word list stays as it was.
    struct Forget(&'static str);
    impl Drop for Forget {
        fn drop(&mut self) {
            NSSpellChecker::sharedSpellChecker().unlearnWord(&NSString::from_str(self.0));
        }
    }

    #[test]
    fn a_learned_word_is_no_longer_misspelled() {
        let word = "Undertextish";
        let _forget = Forget(word);
        assert_eq!(words("An Undertextish page."), vec![(3, 15)]);
        learn_spelling(word.to_string());
        assert_eq!(words("An Undertextish page."), vec![]);
    }

    #[test]
    fn finds_a_learned_word_in_either_case_and_unlearns_it() {
        let word = "zorbletish";
        let _forget = Forget(word);
        assert!(!learned_spelling("Zorbletish".into()));
        learn_spelling(word.into());
        assert!(learned_spelling("Zorbletish".into()));
        assert_eq!(words("A Zorbletish page."), vec![]);
        // From the page's capitalized form, as a right click finds it.
        unlearn_spelling("Zorbletish".into());
        assert!(!learned_spelling("zorbletish".into()));
        assert_eq!(words("A Zorbletish page."), vec![(2, 12)]);
    }
}

#[cfg(test)]
mod word_tests {
    use super::words;

    fn texts(text: &str) -> Vec<String> {
        words(text).into_iter().map(|w| w.2).collect()
    }

    #[test]
    fn keeps_apostrophes_inside_words_and_splits_on_hyphens() {
        assert_eq!(texts("Don’t split it's, re-check."), ["Don’t", "split", "it's", "re", "check"]);
        // A trailing apostrophe is not part of the word.
        assert_eq!(texts("the dogs' bone"), ["the", "dogs", "bone"]);
    }

    #[test]
    fn skips_words_with_digits_or_underscores() {
        assert_eq!(texts("the 3rd snake_case word"), ["the", "word"]);
        assert!(texts("").is_empty());
    }

    #[test]
    fn counts_offsets_in_utf16() {
        // "é" is one UTF-16 unit and "😀" two, so "teh" starts at 8.
        assert_eq!(
            words("café 😀 teh"),
            [(0, 4, "café".to_string()), (8, 11, "teh".to_string())]
        );
    }
}

/// Needs a dictionary: `sudo pacman -S hunspell-en_us`, then
/// `LANG=en_US.UTF-8 cargo test --lib enchant -- --ignored`.
#[cfg(all(test, target_os = "linux"))]
mod enchant_tests {
    #[test]
    #[ignore]
    fn marks_misspelled_words_and_guesses() {
        let checked = super::check("We teh people recieve it.", || None);
        assert_eq!(checked.language.as_deref(), Some("en_US"));
        assert_eq!(checked.words, [(3, 6), (14, 21)]);
        assert!(super::guesses("recieve", None).contains(&"receive".to_string()));
        assert!(super::check("Don’t worry.", || None).words.is_empty());
    }
}
