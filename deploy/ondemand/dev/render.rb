#!/usr/bin/env ruby
# Render one of the app's ERB templates the way Open OnDemand does, with a mock
# form context, to test the app off-site:
#
#   ruby deploy/ondemand/dev/render.rb deploy/ondemand/fiberbrowser/template/script.sh.erb \
#        '{"lab_data_dir": "/data/lab", "num_cores": "4", ...}' > script.sh
#
# The JSON holds the form's values (as strings, like OnDemand's) and, for
# view.html.erb, the connection's host/port/password. Standard library only.
require 'erb'
require 'json'
require 'ostruct'
require 'shellwords'

template, values = ARGV
abort "usage: render.rb TEMPLATE.erb 'JSON'" unless template && values
data = JSON.parse(values)
context = OpenStruct.new(data)
host = data['host']
port = data['port']
password = data['password']
num_cores = data['num_cores']
memory_gb = data['memory_gb']
erb = ERB.new(File.read(template), nil, '-')
print erb.result(binding)
