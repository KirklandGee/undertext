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
}

#[cfg(target_os = "macos")]
use mac::{check, guesses, language_of, learn};

// Undertext is built for macOS. Elsewhere, nothing is marked.
#[cfg(not(target_os = "macos"))]
fn check(_text: &str, _page_language: impl FnOnce() -> Option<String>) -> Checked {
    Checked {
        language: None,
        words: Vec::new(),
    }
}
#[cfg(not(target_os = "macos"))]
fn language_of(_sample: &str) -> Option<String> {
    None
}
#[cfg(not(target_os = "macos"))]
fn guesses(_word: &str, _language: Option<&str>) -> Vec<String> {
    Vec::new()
}
#[cfg(not(target_os = "macos"))]
fn learn(_word: &str) {}

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

    #[test]
    fn a_learned_word_is_no_longer_misspelled() {
        let word = "Undertextish";
        // Forget it again even if an assertion fails, so the Mac's word list stays as it was.
        struct Forget(&'static str);
        impl Drop for Forget {
            fn drop(&mut self) {
                NSSpellChecker::sharedSpellChecker().unlearnWord(&NSString::from_str(self.0));
            }
        }
        let _forget = Forget(word);
        assert_eq!(words("An Undertextish page."), vec![(3, 15)]);
        learn_spelling(word.to_string());
        assert_eq!(words("An Undertextish page."), vec![]);
    }
}
