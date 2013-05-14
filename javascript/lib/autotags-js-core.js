/**
*	A U T O T A G S
*
*	Automatic tag suggestions or keyword generation for text, using unsupervised
*	semantic analysis.
*
*	Copyright (C) 2007  Hjortur Stefan Olafsson
*
*	This program is free software: you can redistribute it and/or modify
*	it under the terms of the GNU General Public License as published by
*	the Free Software Foundation, either version 3 of the License, or
*	(at your option) any later version.
*
*	This program is distributed in the hope that it will be useful,
*	but WITHOUT ANY WARRANTY; without even the implied warranty of
*	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
*	GNU General Public License for more details.
*
*	You should have received a copy of the GNU General Public License
*	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
*	@version 1.3
*
*	TODO Remove redundant lowercasing
*	TODO Choose best inflection after stemming (based on frequency)
*	TODO Apply further weighting based on position, applying more weighting for terms that appear at the beginning
*	TODO Separate out language specific regular expressions
*	TODO Support multiple sets of text with different weightings (field weights)
*	TODO Add support for "associated" tags (e.g when suggesting 'lucene' also add 'search', 'java')
*	TODO Support term normalisation ( 'youtube', 'iFilm' -> 'video sharing' )
*
*/

var AUTOTAGS = {
	'NAME' : 'AutoTags',
	'VERSION' : 1.3,
	'DEFAULT_COMPOUND_TAG_SEPARATOR' : ' ',
	'APPLY_STEMMING' : true, // If true then the Porter stemmer should be applied to all tokens (but not phrases or n-grams), this has some overhead
	'BOUNDARY' : '##!##' // Compound terms will not be created across BOUNDARIES
};


/*
*
*	Create an instance of AutoTags
*
*/
AUTOTAGS.createTagger = function( parameters ) {
	/*
	*
	*	Switches and Dials
	*
	*/
	this.REMOVE_SHORT_NUMBERS_AS_SINGLE_TOKENS = true; // Remove all numbers with 4 digits or less
	this.LOWERCASE = true; // If true all terms are lowercased before returning
	this.EXTRACT_SPECIAL_TERMS = true; // Extract abbreviations, acronyms and CamelCase words.
	
	this.TOKEN_LENGTH_CUTOFF = 2; // Only consider single tokens that are longer than n characters
	this.TERM_FREQUENCY_CUTOFF = 1; // Ignore terms that have fewer than n occurrences
	this.SCORE_CUTOFF = 0; // Ignoring terms that score less than n

	this.SINGLE_TERM_BOOST = 0.75;
	this.WHITE_LIST_BOOST = 1.5; // This boost is applied to all words found in the white list
	this.CAPITALIZATION_BOOST = 1.75; // This boost is applied once to capitalised tokens, and again if all caps
	this.NGRAM_BASED_ON_CAPITALISATION_BOOST = 3.5; // This boost is applied to capitalised bi- and trigrams
	this.SPECIAL_TERM_BOOST = 2.5; // This boost is applied to capitalised bi- and trigrams
	this.BIGRAM_BOOST = 2.5; // This is applied to bigrams that do not contain stopwords and whose individual tokens are longer than 2 characters
	this.BIGRAM_ALREADY_DETECTED_BOOST = 0.25; // This boost is applied to all bigrams found to be wholly contained within a compound term detected based on capitalisation
	this.TERM_FROM_COMPOUND_DOWNWEIGHT = 0.25; // This is applied to individual tokens within an n-gram (every time an n-gram is discovered)
	
	this.COMPOUND_TAG_SEPARATOR = AUTOTAGS.DEFAULT_COMPOUND_TAG_SEPARATOR; // Intra-tag (e.g. cool_gadget vs. cool gadget) separator to use
	
	// Remove all whitespace characters (certain white space characters are turned into boundaries)
	this.WHITESPACE_EXPRESSION = /(\')?([^a-zA-Z0-9_\.\!\?\:\;\n\r\f\t])/g;
	// Look for compound terms (bi- and trigrams) based on capitalization, accounting for corner cases like PayPal, McKinley etc.
	// TODO Need to estimate whether this is too greedy or not
	this.CAPITALIZED_NGRAM_EXPRESSION = /(([A-Z][a-z]*)?[A-Z][a-z]+ (of )?(Mc|Mac)?[A-Z][a-z]+([ \-][A-Z][a-z]+)?([ ][A-Z][a-z]+)?)/g;
	// Special Terms Expression to extract e.g. abbreviations and acronyms (with support for CamelCase words like JavaScript)
	this.SPECIAL_TERMS_EXPRESSION = /\b([A-Za-z]{1,2}\-[A-Za-z]+)|(([A-Z]\.){2,})|((([A-Z][A-Z0-9\-\:\_\+]+)|([A-Z]+[a-z]*?[A-Z][a-z]*?))( [A-Z][A-Za-z]+)?( [A-Z][A-Za-z]+)?( [0-9]*(\.[0-9]*)?)?)\b/g;
	// This expression looks for 'short numbers' with less than four digits (this will be included in stopword expression)
	this.SHORT_NUMBERS_EXPRESSION = '[0-9]{1,3}';
	
	
	/*
	*	Setting all formal parameters (overriding default parameters)
	*/
	if ( typeof parameters != 'undefined' ) {
		for ( var property in parameters ) {
			if( typeof this[property] != 'undefined' ) {
				this[property] = parameters[property];
			}
		}
	}
	
	// This is the whitelist cache
	this.whitelistCache = {};
	// Tag constants
	this.tagConstants;
};

AUTOTAGS.createTagger.prototype = {
	
	/*
	*	Analyze Text
	*/
	analyzeText : function( text, numberOfTagsToReturn ) {

		// Starting
		var startTime = new Date().getTime();

		// Data Structures
		var frequencyListSingleTerms = new AUTOTAGS.FrequencyList();
		var frequencyListCapitalisedCompoundTerms = new AUTOTAGS.FrequencyList();
		var frequencyListSimpleBigramTerms = new AUTOTAGS.FrequencyList();
		var frequencyListSpecialTerms = new AUTOTAGS.FrequencyList();
		
		// Instance Variables
		var algorithmTime = 0;




		/*
		*
		* Pre-processing text
		*
		*/
		
		// Replacing all whitespace characters with a single space
		var textWithWhitespaceRemoved = ( ' ' + text + ' ' ).replace( this.WHITESPACE_EXPRESSION, ' ' );
		
		// Swapping certain punctuation for a boundary marker
		var textWithBoundaryMarkers = textWithWhitespaceRemoved.replace( /([ ]*[\.\!\?\:\;\n\r\f\t][ ]*)+/g , (' ' + AUTOTAGS.BOUNDARY + ' ') );
		
		// Removing stopwords
		var textWithWhitespaceAndStopwordsRemoved = textWithBoundaryMarkers.replace(this._getStopWordRegExpression(), ' ');
		
		// Splitting tokens into individual terms
		var tokensToProcess = textWithWhitespaceAndStopwordsRemoved.split(' ');




		/*
		*
		* 1st Pass (building the frequency list)
		*
		*/
		
		// Identifying all single term candidates
		for ( var i = 0, length = tokensToProcess.length; i < length; i++ ) {
			var token = tokensToProcess[i];
			
			if ( token.length > this.TOKEN_LENGTH_CUTOFF ) {
				var term = new AUTOTAGS.Term({ 'boost':this.SINGLE_TERM_BOOST });
				term.setValue( token );
				term.ignoreTermFreqCutoff = false;

				// Adding the candidate to the frequency list
				frequencyListSingleTerms.addTerm( term );
			}
		}
		
		// Identifying all special terms
		if ( this.EXTRACT_SPECIAL_TERMS ) {
			var specialTerms = text.match( this.SPECIAL_TERMS_EXPRESSION );
			if ( specialTerms != null ) {
				for ( var i = 0, length = specialTerms.length; i < length; i++ ) {
					var term = new AUTOTAGS.Term({ 'termType': AUTOTAGS.TermConstants.TYPE_SPECIAL_TERM, 'boost':this.SPECIAL_TERM_BOOST });
					term.setValue( AUTOTAGS.trim(specialTerms[i]) );
					term.ignoreTermFreqCutoff = true;

					// Adding the candidate to the frequency list
					frequencyListSpecialTerms.addTerm( term );
				}
			}
		}
		
		// Identifying compound terms based on capitalization
		var capitalizedNGrams = textWithBoundaryMarkers.match( this.CAPITALIZED_NGRAM_EXPRESSION );
		
		if ( capitalizedNGrams != null ) {
			for ( var i = 0, length = capitalizedNGrams.length; i < length; i++ ) {
				var compoundTermValue = capitalizedNGrams[i];

				// The compound term should not start with a word from the blacklist, I try removing it and see what I'm left with.
				var compoundTermArray = compoundTermValue.split(' ');
				if ( this.isInBlackList( compoundTermArray[0] ) ) {
					compoundTermValue = compoundTermValue.substr( compoundTermValue.indexOf(' ') + 1 );
				}
				
				var term = new AUTOTAGS.Term({ 'termType': AUTOTAGS.TermConstants.TYPE_CAPITALISED_COMPOUND_TERM, 'boost':this.NGRAM_BASED_ON_CAPITALISATION_BOOST });
				term.setValue( compoundTermValue );
				term.ignoreTermFreqCutoff = true;

				// Adding the candidate to the frequency list
				frequencyListCapitalisedCompoundTerms.addTerm( term );
			}
		}
		
		// Identifying bi-grams in the text
		var bigrams = textWithBoundaryMarkers.split(' ');
		
		for ( var i = 0, length = bigrams.length; i < length; i++ ) {
			var position = i;
			
			var token1 = bigrams[position];
			var token2 = bigrams[position + 1];
			if ( token1 != undefined && token2 != undefined && (token1.length > 2 && token2.length > 2 ) && this.isInBlackList(token1) == false && this.isInBlackList(token2) == false ) {
				var bigram = token1 + ' ' + token2;
				var term = new AUTOTAGS.Term({ 'termType': AUTOTAGS.TermConstants.TYPE_SIMPLE_BIGRAM_TERM, 'boost':this.BIGRAM_BOOST });
				term.setValue( bigram );
				term.ignoreTermFreqCutoff = false;
				
				// Adding the candidate to the frequency list
				frequencyListSimpleBigramTerms.addTerm( term );
			}
		}




		/*
		*
		* 2nd Pass (evaluation and scoring of individual and compound terms)
		*
		*/
		
		var temporaryTagSet = new AUTOTAGS.TagSet();
		
		// The order in which the frequency lists are analyzed is important!!!
		var frequencyLists = [ frequencyListSpecialTerms, frequencyListCapitalisedCompoundTerms, frequencyListSimpleBigramTerms, frequencyListSingleTerms ];
		
		for ( var listId = 0, length = frequencyLists.length; listId < length; listId++ ) {
			var listBeingProcessed = frequencyLists[listId];
			
			// Analyzing all terms within the list
			for ( var termId in listBeingProcessed.getTerms() ) {
				var term = listBeingProcessed.getTermById( termId );
				var ignoreTerm = false;

				if ( (term.freq > this.TERM_FREQUENCY_CUTOFF) || (this.isInWhiteList(term.getValue()) || term.ignoreTermFreqCutoff == true) ) {
				
					/*
					* Filtering...removing obvious duplicate terms between across lists and deciding between capitalised
					* compound terms and bigrams (for which there might exist corresponding entries in both lists)
					*/
					if ( term.termType == AUTOTAGS.TermConstants.TYPE_SPECIAL_TERM ) {
						var ignoreSpecialTerm = false;
						// Process all frequency lits but the special term one...
						for ( var specialTermLookupListId = 0; specialTermLookupListId < length ; specialTermLookupListId++ ) {
							var specialTermLookupList = frequencyLists[specialTermLookupListId];
							if ( specialTermLookupList == listBeingProcessed ) {
								// This is the special term list, move on...
								continue;
							} else {
								// Checking if this special term exists in the list being processed
								var termToLookup = term.getTermId();
								// I'm maybe being to greedy here - if the special term doesn't exist in it's natural form in the single term list I try stemming it...
								if ( specialTermLookupList == frequencyListSingleTerms && specialTermLookupList.getTermById( termToLookup ) == undefined) {
									termToLookup = AUTOTAGS._stemToken(termToLookup);
								}
								if ( specialTermLookupList.getTermById( termToLookup ) != undefined ) {
									var specialTermInList = specialTermLookupList.getTermById( termToLookup );
									// If a more frequent or higher scoring variant of the special term is found in one of the other lists then ignore this one
									if ( specialTermInList.getScore() > term.getScore() ) {
										ignoreTerm = true;
										continue;
									} else {
										// The special term is more frequent or higher scoring...so delete from the other list
										specialTermLookupList.deleteTermById( termToLookup );
									}
								}
							}
						}
					} else if ( term.termType == AUTOTAGS.TermConstants.TYPE_CAPITALISED_COMPOUND_TERM ) {
						/*
						* Checking if term is TYPE_CAPITALISED_COMPOUND_TERM!
						* These capitalised compounds require special handling. If they exist in the bigram frequency list, they are clearly
						* bigrams and therefore we should consider which frequency number to use, since there clearly might be more instances if
						* we ignore case.
						*/
						var bigram = frequencyListSimpleBigramTerms.getTermById( term.getTermId() );
						
						if ( bigram != undefined ) {
							// The capitalised compound term exists as a bigram
							if ( bigram.freq > term.freq ) {
								// There are more bigram variants than compound ones. I will therefore ignore the compound one since
								// it may e.g. have been capitalised in a title.
								// Adding a boost to the upcoming bigram variant since it's clearly more than just a normal bigram
								bigram.addBoost( this.CAPITALIZATION_BOOST );
								ignoreTerm = true;
							} else {
								// There is an equal or less number of bigrams, therefore I remove the bigram and go with the capitalised variant
								frequencyListSimpleBigramTerms.deleteTermById( term.getTermId() );
							}
						}
						
						// Now checking if it exists as a simple term (that might happen if I remove blacklisted word at the front)
						var simpleTerm = frequencyListSingleTerms.getTermById( term.getTermId() );
						if ( !ignoreTerm && simpleTerm != undefined ) {
							if ( simpleTerm.getScore() > term.getScore() ) {
								simpleTerm.addBoost( this.CAPITALIZATION_BOOST );
								ignoreTerm = true;
							} else {
								frequencyListSingleTerms.deleteTermById( term.getTermId() );
							}
						}
					}
					
					/*
					* Calculating initial boosts
					*/
				
					// Term is in the whitelist
					if ( this.isInWhiteList( term.getValue() ) ) term.addBoost( this.WHITE_LIST_BOOST );
					if ( !term.isCompoundTerm() ) {
						// Term is capitalized
						if ( term.getValue().substring(0,1).toUpperCase() == term.getValue().substring(0,1) ) {
							term.addBoost( this.CAPITALIZATION_BOOST );
						}
						// Term is all in caps (double boost)
						if ( term.getValue().toUpperCase() == term.getValue() ) {
							term.addBoost( this.CAPITALIZATION_BOOST );
						}
					}
				
					// Lowercasing the word if specified by the LOWERCASE parameter
					if ( this.LOWERCASE ) {
						term.setValue( term.getValue().toLowerCase() );
					}

					// Adding the term to final stage evaluation if it meets the SCORE_CUTOFF criteria
					if ( !ignoreTerm && term.getScore() > this.SCORE_CUTOFF ) {
						temporaryTagSet.addTag( term );
					}	
				}
			}
		}
		
		
		
		
		/*
		*
		* 3rd Pass (Order based on score and further honing based on that order)
		*
		*/
		
		// Sorting the TagSet array by score
		temporaryTagSet.sortByScore();
		
		// Final TagSet to be returned
		var tagSetToBeReturned = new AUTOTAGS.TagSet();
		
		// This array will hold bigrams of the detected compound terms for quick lookup when general bigrams are detected
		var temporaryBigramArrayOfCapitalizedNGrams = new Array();
		var temporaryArrayOfSplitBigrams = new Array();
		
		for ( t in temporaryTagSet.tags ) {
			var term = temporaryTagSet.tags[t];
			
			if ( term.termType == AUTOTAGS.TermConstants.TYPE_CAPITALISED_COMPOUND_TERM ) {
				// Checking if term is TYPE_CAPITALISED_COMPOUND_TERM
				// Adding a bigram of it to a temporary array
				temporaryBigramArrayOfCapitalizedNGrams = temporaryBigramArrayOfCapitalizedNGrams.concat( this._toBigramArray( term.getValue().toLowerCase() ) );
				// Adding compound term components to a separate array to downweight single terms found within a 
				// higher scoring compound term
				var capitalisedCompoundTermComponents = term.getValue().toLowerCase().split(' ');
				
				for ( t in capitalisedCompoundTermComponents ) {
					var tokenToAdd = capitalisedCompoundTermComponents[t];
					
					if ( AUTOTAGS.APPLY_STEMMING ) {
						tokenToAdd = AUTOTAGS._stemToken( tokenToAdd );
					}
					
					temporaryArrayOfSplitBigrams.push( tokenToAdd );
				}
			} else if ( term.termType == AUTOTAGS.TermConstants.TYPE_SIMPLE_BIGRAM_TERM ) {
				// If this bigram exists in the array of 'bigrams made from capitalised compound terms' it means that 
				// the capitalised compound term is higher scoring (since it went before) and therefore should the simple
				// bigram which is	contained wholly within the capitalised compound term be downweighted.
				if ( AUTOTAGS._arrayContains( temporaryBigramArrayOfCapitalizedNGrams, term.getValue().toLowerCase() ) ) {
					term.addBoost( this.BIGRAM_ALREADY_DETECTED_BOOST );
				}
				
				// Adding bigram components to a separate array to downweight single terms found within a 
				// higher scoring bigram
				var bigramComponents = term.getValue().toLowerCase().split(' ');
				
				for ( t in bigramComponents ) {
					var bigramTokenToAdd = bigramComponents[t];
					
					if ( AUTOTAGS.APPLY_STEMMING ) {
						bigramTokenToAdd = AUTOTAGS._stemToken( bigramTokenToAdd );
					}
					
					temporaryArrayOfSplitBigrams.push( bigramTokenToAdd );
				}
				
			} else if ( term.termType == AUTOTAGS.TermConstants.TYPE_SINGLE_TERM ) {
				// Checking if this simple term is found within a higher scoring bigram
				// If it is found in the temporary array of split bigrams it means that it has a lower score
				// since the bigram was processed before it.
				var termValue = term.getValue();
				if ( AUTOTAGS.APPLY_STEMMING ) termValue = AUTOTAGS._stemToken(termValue);
				if ( AUTOTAGS._arrayContains( temporaryArrayOfSplitBigrams, termValue ) ) {
					term.addBoost( this.TERM_FROM_COMPOUND_DOWNWEIGHT );
				}
			}
			
			if ( this.COMPOUND_TAG_SEPARATOR != AUTOTAGS.DEFAULT_COMPOUND_TAG_SEPARATOR ) {
				term.setValue( term.getValue().replace( / /g, this.COMPOUND_TAG_SEPARATOR ) );
			}
			
			tagSetToBeReturned.addTag( term );
		}
		
		// Cleaning up...
		temporaryBigramArrayOfCapitalizedNGrams.length = 0;
		temporaryArrayOfSplitBigrams.length = 0;
		temporaryTagSet.length = 0;
		
		// Sorting the TagSet array by score
		tagSetToBeReturned.sortByScore();
		
		// Slicing out top tags to return
		tagSetToBeReturned.tags = tagSetToBeReturned.tags.slice( 0, numberOfTagsToReturn );	
		tagSetToBeReturned.addAllTags( this.getTagConstants() );
		
		// Done
		this._setAlgorithmTime( new Date().getTime() - startTime );
		
		return tagSetToBeReturned;
	},
	
	getTagConstants : function() {
		if ( this.tagConstants != undefined ) {
			return this.tagConstants;
		} else {
			this.tagConstants = new Array();
			
			if ( AUTOTAGS.TAG_CONSTANTS != undefined ) {
				for ( var i = 0, length = AUTOTAGS.TAG_CONSTANTS.length; i < length; i++ ) {
					var constant = new AUTOTAGS.Term({'termType':AUTOTAGS.TermConstants.TYPE_TAG_CONSTANT});
					constant.setValue(AUTOTAGS.TAG_CONSTANTS[i]);
					this.tagConstants.push( constant );
				}
			}
			
			return this.tagConstants;
		}
	},
	
	_toBigramArray : function( compoundTerm ) {
		var bigramArray = new Array();
		
		var splitTerm = compoundTerm.split( ' ' );
		
		for ( var i = 0, length = splitTerm.length; i < length; i++ ) {
			var position = i;

			var token1 = splitTerm[position];
			var token2 = splitTerm[position + 1];

			if ( token1 != undefined && token2 != undefined ) {
				bigramArray.push( token1 + ' ' + token2 );
			}
		}
		
		return bigramArray;
	},
	
	isInWhiteList : function( term ) {
		// Whitelist lookup with caching
		// In case the same words are prevalent in the text I can avoid looking them up again
		if ( this.whitelistCache['_' + term] != undefined ) {
			return this.whitelistCache['_' + term];
		} else {
			try {
				var inWhiteList = false;
				if ( AUTOTAGS.WHITELIST != undefined ) {
					inWhiteList = AUTOTAGS._arrayContains( AUTOTAGS.WHITELIST, term.toLowerCase() );
					this.whitelistCache['_' + term] = inWhiteList;
				}
				return inWhiteList;
			} catch ( e ) {
				return false;
			}
		}
	},

	isInBlackList : function( term ) {
		if ( term != AUTOTAGS.BOUNDARY && ( AUTOTAGS.BLACKLIST != undefined && AUTOTAGS.BLACKLIST[term.toLowerCase()] != true ) ) {
			return false;
		} else {
			return true;
		}
	},
	
	_getStopWordRegExpression : function() {
		var blacklistExpression = AUTOTAGS.BOUNDARY;
		
		// Adding all blacklist terms
		if ( AUTOTAGS.BLACKLIST != undefined ) {
			for ( var term in AUTOTAGS.BLACKLIST ) {
				blacklistExpression += '|' + term;
			}
		}

		if ( this.REMOVE_SHORT_NUMBERS_AS_SINGLE_TOKENS ) {
			return new RegExp( '\\s((' + this.SHORT_NUMBERS_EXPRESSION + '|' + blacklistExpression + ')\\s)+', 'gi' );
		} else {
			return new RegExp( '\\s((' + blacklistExpression + ')\\s)+', 'gi' );
		}
	},
		
	getAlgorithmTime : function() {
		return this.algorithmTime;
	},
	
	_setAlgorithmTime : function( timeInMilliseconds ) {
		this.algorithmTime = timeInMilliseconds;
	}
};




/*
*
*	Term Business Object
*
*/
AUTOTAGS.TermConstants = {
	'TYPE_SINGLE_TERM' : 'TYPE_SINGLE_TERM',
	'TYPE_CAPITALISED_COMPOUND_TERM' : 'TYPE_CAPITALISED_COMPOUND_TERM',
	'TYPE_SIMPLE_BIGRAM_TERM' : 'TYPE_SIMPLE_BIGRAM_TERM',
	'TYPE_SPECIAL_TERM' : 'TYPE_SPECIAL_TERM',
	'TYPE_TAG_CONSTANT' : 'TYPE_TAG_CONSTANT'
};

AUTOTAGS.Term = function( parameters ) {
	// Fields
	this._termId = '';
	this._term = '';
	this.termType = AUTOTAGS.TermConstants.TYPE_SINGLE_TERM;
	this.freq = 1;
	this.ignoreTermFreqCutoff = false;
	this.score = 0;
	this.boost = 1;
	
	if ( typeof parameters != 'undefined' ) {
		for ( var property in parameters ) {
			if( typeof this[property] != 'undefined' ) {
				this[property] = parameters[property];
			}
		}
	}
};

AUTOTAGS.Term.prototype = {
	addBoost : function( boostFactor ) {
		this.boost *= boostFactor;
	},

	incrementFrequency : function() {
		this.freq++;
	},
	
	getScore : function() {
		this.score = this.freq*this.boost;
		
		return this.score;
	},
	
	getValue : function() {
		return this._term;
	},
	
	setValue : function( value ) {
		this._term = value;
		this._setTermId(value);
	},
	
	getTermId : function() {
		return this._termId;
	},
	
	_setTermId : function( value ) {
		// If this is a single token and stemming should be applied then modify the termID
		if ( AUTOTAGS.APPLY_STEMMING && !this.isCompoundTerm() ) {
			this._termId = '_' + AUTOTAGS._stemToken( value );
		} else {
			this._termId = '_' + value.toLowerCase();
		}
	},
	
	getTermType : function() {
		return this.termType;
	},
	
	isCompoundTerm : function() {
		return this.termType != AUTOTAGS.TermConstants.TYPE_SINGLE_TERM;
	},
	
	toString : function() {
		return this.getValue();
	},
	
	valueEquals : function( term ) {
		return new String( this.toString() ) == new String( term.toString() );
	},
	
	valueEqualsIgnoreCase : function( term ) {
		return new String( this.toString() ).toLowerCase() == new String( term.toString() ).toLowerCase();
	}
};




/*
*
*	TagSet Business Object
*
*/
AUTOTAGS.TagSet = function( parameters ) {
	this.tags = new Array();
	this.TAG_SEPARATOR = ', ';
	
	if ( typeof parameters != 'undefined' ) {
		for ( var property in parameters ) {
			if( typeof this[property] != 'undefined' ) {
				this[property] = parameters[property];
			}
		}
	}
};

AUTOTAGS.TagSet.prototype = {
	addTag : function( term ) {
		this.tags.push( term );
	},
	
	addAllTags : function( tagArray ) {
		this.tags = this.tags.concat( tagArray );
	},
	
	getTags : function() {
		return this.tags;
	},
	
	toString : function( separator ) {
		if ( separator != undefined ) {
			this.TAG_SEPARATOR = separator;
		}
		
		return this.tags.join( this.TAG_SEPARATOR );
	},
	
	sortByScore : function() {
		this.tags.sort( this._scoreComparator );
	},
	
	_scoreComparator : function( a, b ) {
		return b.getScore() - a.getScore();
	}
};




/*
*
*	Frequency List Business Object
*
*/
AUTOTAGS.FrequencyList = function( parameters ) {
	this._terms = new Object();
	
	if ( typeof parameters != 'undefined' ) {
		for ( var property in parameters ) {
			if( typeof this[property] != 'undefined' ) {
				this[property] = parameters[property];
			}
		}
	}
};

AUTOTAGS.FrequencyList.prototype = {
	addTerm : function( term ) {
		// Is the term in the frequency list? If so then retrieve it and increment frequency
		if ( this.getTermById( term.getTermId() ) != undefined ) {
			// Getting only frequency from the existing term, updating everything else
			term.freq = (this.getTermById( term.getTermId() ).freq + 1);
		}
		
		// Updating frequency list with the term being processed
		this._terms[term.getTermId()] = term;
	},
	
	getTermById : function( termId ) {
		return this._terms[ termId ];
	},
	
	getTerms : function() {
		return this._terms;
	},
	
	deleteTermById : function( termId ) {
		delete this._terms[termId];
	},
	
	toArray : function() {
		var arrayToReturn = new Array();
		
		for ( var termId in this._terms ) {
			arrayToReturn.push( this._terms[termId] );
		}
		
		return arrayToReturn;
	}
};




/*
*	Get the root of a given word
*/
AUTOTAGS._stemToken = function( token ) {
	token = token.toLowerCase();
	// Find the root of words and cache since stemming is fairly expensive in this context
	if ( AUTOTAGS.VARIATION_CACHE['_' + token] != undefined ) {
		// Token is found in the cache
		var stemmedVariant = AUTOTAGS.VARIATION_CACHE['_' + token];
		return stemmedVariant;
	} else {
		// Token not in the cache, stemming and adding to the cache
		try {
			var stemmerImpl = AUTOTAGS._getStemmerImpl();
			var stemmedVariant = stemmerImpl( token );
			
			AUTOTAGS.VARIATION_CACHE['_' + token] = stemmedVariant;
			
			return stemmedVariant;
		} catch ( e ) {
			return token;
		}
	}
};

AUTOTAGS._getStemmerImpl = function() {
	return stemWord;
};

AUTOTAGS.trim = function( string ) {
	var	string = string.replace(/^\s\s*/, '');
	var ws = /\s/;
	var len = string.length;
	
	while ( ws.test(string.charAt(--len)) );
	
	return string.slice(0, len + 1);
};

AUTOTAGS._arrayContains = function( array, obj ) {
	try {
		return array.indexOf( obj ) > -1;
	} catch ( e ) {
		for ( var i = 0, length = array.length; i < length; i++ ) {
			if (array[i] == obj) {
				return true;
			}
		}
		return false;
	}
};




/*
*
*	Cache objects
*
*/

// This is a cache of all root words (stemmed variants) for quick lookup (stemming is fairly expensive in this context)
AUTOTAGS.VARIATION_CACHE = {};