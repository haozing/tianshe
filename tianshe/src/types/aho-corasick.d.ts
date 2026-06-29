/**
 * Type declarations for aho-corasick
 *
 * Aho-Corasick string matching algorithm implementation
 */

declare module 'aho-corasick' {
  /**
   * Match result returned by the search method
   */
  interface MatchResult {
    /** The matched word/pattern */
    0: string;
    /** Additional data associated with the match */
    1?: any;
    /** Starting position of the match */
    2?: number;
  }

  /**
   * Aho-Corasick automaton for efficient multi-pattern string matching
   */
  class AhoCorasick {
    /**
     * Create a new Aho-Corasick automaton
     * @param words - Optional array of words to add to the automaton
     */
    constructor(words?: string[]);

    /**
     * Add a word to the automaton
     * @param word - The word to add
     * @param data - Optional data to associate with the word
     */
    add(word: string, data?: any): void;

    /**
     * Build failure links for the automaton
     * Must be called after adding all words and before searching
     */
    build_fail(): this;

    /**
     * Search for patterns in the given text
     * @param text - The text to search in
     * @param callback - Optional callback function called for each match
     * @returns Array of matches or the automaton instance (when callback is provided)
     */
    search(text: string): MatchResult[];
    search(text: string, callback: (word: string, data?: any, offset?: number) => void): this;

    /**
     * Generate a GraphViz DOT representation of the automaton
     */
    to_dot(): string;
  }

  export = AhoCorasick;
}
