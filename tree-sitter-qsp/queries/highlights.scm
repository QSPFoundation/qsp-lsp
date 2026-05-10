; highlights.scm - Tree-sitter highlight queries for QSP

; Location blocks
(location_header) @module
(location_name) @module.definition
(location_end) @module

; Keywords
(if_keyword) @keyword.control
(elseif_keyword) @keyword.control
(else_keyword) @keyword.control
(end_keyword) @keyword.control
(act_keyword) @keyword.control
(loop_keyword) @keyword.control.repeat
(while_keyword) @keyword.control.repeat
(step_keyword) @keyword.control.repeat
(set_keyword) @keyword
(local_keyword) @keyword

; Keyword operators
(op_and) @keyword.operator
(op_or) @keyword.operator
(op_mod) @keyword.operator
(op_no) @keyword.operator
(op_obj) @keyword.operator
(op_loc) @keyword.operator

; Statements
(statement_name) @function.builtin

; Functions
(function_name) @function.builtin

; User functions and calls
(user_func_call name: (user_name) @function)
(ml_user_func_call name: (user_name) @function)
(user_call_statement name: (user_name) @function)

; Variables
(variable_ref prefix: (type_prefix) @punctuation.special name: (identifier_text) @variable)
(variable_ref name: (identifier_text) @variable)
(ml_variable_ref prefix: (type_prefix) @punctuation.special name: (identifier_text) @variable)
(ml_variable_ref name: (identifier_text) @variable)

; Labels
(label_statement name: (label_name) @label)

; Operators
(assignment_operator) @operator
(op_cmp) @operator
(op_arith) @operator
(op_amp) @operator
(op_neg) @operator

; Literals
(number_literal) @number
(single_quoted_string) @string
(double_quoted_string) @string
(string_interpolation "<<" @punctuation.special ">>" @punctuation.special)

; Code blocks
(code_block "{" @punctuation.bracket "}" @punctuation.bracket)
(raw_code_block "{" @punctuation.bracket "}" @punctuation.bracket)

; Comments
(comment_statement) @comment

; Note string (after END)
(note_string) @comment

; Punctuation
(paren_expr "(" @punctuation.bracket ")" @punctuation.bracket)
(paren_args "(" @punctuation.bracket ")" @punctuation.bracket)
(paren_tuple "(" @punctuation.bracket ")" @punctuation.bracket)
(bracket_tuple "[" @punctuation.bracket "]" @punctuation.bracket)
(array_index "[" @punctuation.bracket "]" @punctuation.bracket)
